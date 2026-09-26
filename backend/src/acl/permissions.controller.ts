import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  GRANT_KINDS,
  type GrantKind,
  type Permission,
  type PermissionSource,
} from '@kachnadocs/shared';
import { PermissionService } from './permission.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { query } from '../db';
import { notFound, validationFailed } from '../http-errors';
import type { AuthUser } from '@kachnadocs/shared';

interface GrantDto {
  id: string;
  subject_kind: 'user' | 'discord_role';
  subject_id: string;
  subject_name: string;
  target_kind: 'group' | 'document';
  target_id: string;
  target_name: string;
  permission: GrantKind;
}

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissions: PermissionService) {}

  /**
   * Effective permissions for a user, each with its source (SPEC.md:84).
   * A user may always inspect their own grants; seeing someone else's requires
   * MANAGE on the thing they hold it on, so this returns the caller's own view
   * plus anything they manage. Full admin listing is a later phase concern.
   */
  @Get('effective')
  async effective(
    @CurrentUser() me: AuthUser,
    @Query('userId') userId?: string,
  ): Promise<{
    userId: string;
    grants: Array<{
      targetKind: 'group' | 'document';
      targetId: string;
      targetName: string;
      permission: Permission;
      source: PermissionSource;
    }>;
  }> {
    const target = userId ?? me.id;
    if (target !== me.id) {
      // Asking about someone else is a management operation: require MANAGE on
      // at least one of the caller's groups, else treat as not found.
      const manageable = await this.permissions.effectiveForUser(me.id);
      const managesAnything = manageable.some((g) => g.permission === 'MANAGE');
      if (!managesAnything) throw notFound();
    }
    return { userId: target, grants: await this.permissions.effectiveForUser(target) };
  }

  /** All explicit grants, restricted to targets the caller can manage. */
  @Get()
  async list(@CurrentUser() me: AuthUser): Promise<GrantDto[]> {
    const rows = await query<GrantDto & { target_group_id: string | null; target_document_id: string | null }>(
      `SELECT
         p.id,
         CASE WHEN p.subject_user_id IS NOT NULL THEN 'user' ELSE 'discord_role' END AS subject_kind,
         COALESCE(p.subject_user_id, p.subject_role_id) AS subject_id,
         COALESCE(su.display_name, sr.name) AS subject_name,
         CASE WHEN p.target_group_id IS NOT NULL THEN 'group' ELSE 'document' END AS target_kind,
         COALESCE(p.target_group_id, p.target_document_id) AS target_id,
         COALESCE(tg.name, td.title) AS target_name,
         p.permission
       FROM permissions p
       LEFT JOIN users su ON su.id = p.subject_user_id
       LEFT JOIN discord_roles sr ON sr.id = p.subject_role_id
       LEFT JOIN groups tg ON tg.id = p.target_group_id
       LEFT JOIN documents td ON td.id = p.target_document_id
       WHERE (p.target_group_id IS NOT NULL AND can_access_group($1, p.target_group_id, 'MANAGE'))
          OR (p.target_document_id IS NOT NULL AND can_access_document($1, p.target_document_id, 'MANAGE'))
       ORDER BY target_kind, target_name, subject_name, permission`,
      [me.id],
    );
    return rows.map(({ target_group_id: _g, target_document_id: _d, ...rest }) => rest);
  }

  /** Grant or replace a permission. Requires MANAGE on the target. */
  @Post()
  async create(
    @CurrentUser() me: AuthUser,
    @Body()
    body: {
      subjectKind?: 'user' | 'discord_role';
      subjectId?: string;
      targetKind?: 'group' | 'document';
      targetId?: string;
      permission?: GrantKind;
    },
  ): Promise<GrantDto> {
    const { subjectKind, subjectId, targetKind, targetId, permission } = body ?? {};
    if (!subjectKind || !subjectId || !targetKind || !targetId) {
      throw validationFailed('subjectKind, subjectId, targetKind, targetId are required');
    }
    if (!GRANT_KINDS.includes(permission as GrantKind)) {
      throw validationFailed(`permission must be one of ${GRANT_KINDS.join(', ')}`);
    }
    const grant = permission as GrantKind;

    // Managing permissions is itself a managed operation (SPEC.md:36).
    const allowed =
      targetKind === 'group'
        ? await this.permissions.canAccessGroup(me.id, targetId, 'MANAGE')
        : await this.permissions.canAccessDocument(me.id, targetId, 'MANAGE');
    if (!allowed) throw notFound();

    const subjectTable = subjectKind === 'user' ? 'users' : 'discord_roles';
    const subjectColumn = subjectKind === 'user' ? 'subject_user_id' : 'subject_role_id';
    const targetTable = targetKind === 'group' ? 'groups' : 'documents';
    const targetColumn = targetKind === 'group' ? 'target_group_id' : 'target_document_id';

    // Subject and target must exist. Note both existence checks answer with the
    // same 404 as a permission failure, so this endpoint cannot be used to
    // probe which ids exist.
    const [subjectOk, targetOk] = await Promise.all([
      query(`SELECT 1 FROM ${subjectTable} WHERE id = $1`, [subjectId]),
      query(`SELECT 1 FROM ${targetTable} WHERE id = $1`, [targetId]),
    ]);
    if (subjectOk.length === 0 || targetOk.length === 0) throw notFound();

    // One grant per (subject, target, permission): replace rather than duplicate.
    await query(
      `DELETE FROM permissions
        WHERE ${subjectColumn} = $1 AND ${targetColumn} = $2 AND permission = $3::permission_kind`,
      [subjectId, targetId, grant],
    );
    await query(
      `INSERT INTO permissions (${subjectColumn}, ${targetColumn}, permission)
       VALUES ($1, $2, $3::permission_kind)`,
      [subjectId, targetId, grant],
    );

    const [row] = await query<GrantDto>(
      `SELECT
         p.id,
         CASE WHEN p.subject_user_id IS NOT NULL THEN 'user' ELSE 'discord_role' END AS subject_kind,
         COALESCE(p.subject_user_id, p.subject_role_id) AS subject_id,
         COALESCE(su.display_name, sr.name) AS subject_name,
         CASE WHEN p.target_group_id IS NOT NULL THEN 'group' ELSE 'document' END AS target_kind,
         COALESCE(p.target_group_id, p.target_document_id) AS target_id,
         COALESCE(tg.name, td.title) AS target_name,
         p.permission
       FROM permissions p
       LEFT JOIN users su ON su.id = p.subject_user_id
       LEFT JOIN discord_roles sr ON sr.id = p.subject_role_id
       LEFT JOIN groups tg ON tg.id = p.target_group_id
       LEFT JOIN documents td ON td.id = p.target_document_id
       WHERE p.${subjectColumn} = $1 AND p.${targetColumn} = $2 AND p.permission = $3::permission_kind`,
      [subjectId, targetId, grant],
    );
    if (!row) throw notFound();
    return row;
  }

  /**
   * Revoke a grant. Requires MANAGE on the grant's target. The guard cannot be
   * used here: the route param is a grant id, not the id of the resource the
   * grant points at, so the check has to resolve the grant first.
   */
  @Delete(':id')
  async remove(@CurrentUser() me: AuthUser, @Param('id') id: string): Promise<{ deleted: boolean }> {
    const [existing] = await query<{ target_group_id: string | null; target_document_id: string | null }>(
      'SELECT target_group_id, target_document_id FROM permissions WHERE id = $1',
      [id],
    );
    if (!existing) throw notFound();

    const allowed = existing.target_document_id
      ? await this.permissions.canAccessDocument(me.id, existing.target_document_id, 'MANAGE')
      : existing.target_group_id
        ? await this.permissions.canAccessGroup(me.id, existing.target_group_id, 'MANAGE')
        : false;
    if (!allowed) throw notFound();

    await query('DELETE FROM permissions WHERE id = $1', [id]);
    return { deleted: true };
  }
}
