import { Injectable } from '@nestjs/common';
import { PERMISSION_RANK, type Permission, type PermissionSource } from '@kachnadocs/shared';
import { query } from '../db';

interface GrantRow {
  permission: Permission;
  source: PermissionSource;
}

/**
 * The only place that decides access (PLAN.md §3). Controllers call into it;
 * list queries use `documentsFilter`/`groupsFilter` so filtering happens in SQL
 * rather than by discarding rows afterwards.
 *
 * Semantics (all implemented in the SQL functions from migration
 * 1740000002000, so there is exactly one implementation):
 *  - MANAGE ⊇ WRITE ⊇ READ
 *  - subject = user or any of their Discord roles
 *  - a group grant applies to that group, its descendants, and documents inside
 *    them; a document grant applies to that document
 *  - no grant at any level => deny
 */
@Injectable()
export class PermissionService {
  /** Best grant the actor holds on a document, with its source. */
  async bestDocumentGrant(
    actorId: string,
    documentId: string,
  ): Promise<GrantRow & { permission: Permission } | null> {
    const rows = await query<{ permission: Permission; source: PermissionSource }>(
      `SELECT permission, source FROM accessible_documents($1, 'READ')
        WHERE document_id = $2
        ORDER BY permission_rank(permission) DESC
        LIMIT 1`,
      [actorId, documentId],
    );
    const row = rows[0];
    return row ? { permission: row.permission, source: row.source } : null;
  }

  async canAccessDocument(
    actorId: string,
    documentId: string,
    required: Permission,
  ): Promise<boolean> {
    const rows = await query<{ ok: boolean }>(
      'SELECT can_access_document($1, $2, $3::permission_kind) AS ok',
      [actorId, documentId, required],
    );
    return rows[0]?.ok === true;
  }

  async canAccessGroup(actorId: string, groupId: string, required: Permission): Promise<boolean> {
    const rows = await query<{ ok: boolean }>(
      'SELECT can_access_group($1, $2, $3::permission_kind) AS ok',
      [actorId, groupId, required],
    );
    return rows[0]?.ok === true;
  }

  /**
   * SQL fragment restricting a query to rows the actor may access.
   *
   *   // query already passes one parameter of its own before the filter
   *   const f = permissionService.documentsFilter(me.id, 'READ', { offset: 1 });
   *   query(`SELECT d.* FROM documents d ${f.sql}`, [stateArg, ...f.params]);
   *
   * Postgres numbers parameters positionally, so a caller with its own
   * parameters must say how many precede ours; otherwise $1 would bind to the
   * caller's value and the ACL would silently filter on the wrong thing.
   * `offset` = number of parameters placed before ours; `f.params` is appended
   * after the caller's own values.
   */
  documentsFilter(
    actorId: string,
    required: Permission,
    options: { column?: string; offset?: number } = {},
  ): { sql: string; params: unknown[] } {
    const column = options.column ?? 'd.id';
    const base = options.offset ?? 0;
    return {
      sql: `WHERE ${column} IN (
              SELECT document_id FROM accessible_documents($${base + 1}, $${base + 2}::permission_kind)
            )`,
      params: [actorId, required],
    };
  }

  groupsFilter(
    actorId: string,
    required: Permission,
    options: { column?: string; offset?: number } = {},
  ): { sql: string; params: unknown[] } {
    const column = options.column ?? 'g.id';
    const base = options.offset ?? 0;
    return {
      sql: `WHERE ${column} IN (
              SELECT group_id FROM accessible_groups($${base + 1}, $${base + 2}::permission_kind)
            )`,
      params: [actorId, required],
    };
  }

  /**
   * Effective permissions for a user across everything they can reach, each
   * with the source label SPEC.md:84 asks for ("zděděno z HR" / "přiděleno přímo").
   */
  async effectiveForUser(actorId: string): Promise<
    Array<{
      targetKind: 'group' | 'document';
      targetId: string;
      targetName: string;
      permission: Permission;
      source: PermissionSource;
    }>
  > {
    const groups = await query<{
      target_id: string;
      target_name: string;
      permission: Permission;
      source: PermissionSource;
    }>(
      `SELECT DISTINCT ON (gg.group_id, gg.permission)
                gg.group_id AS target_id, g.name AS target_name, gg.permission, gg.source
         FROM group_grants_for($1) gg
         JOIN groups g ON g.id = gg.group_id
        -- a direct grant is the better label to show than an inherited one of
        -- the same rank, so order by rank first, then by directness
        WHERE gg.permission <> 'NONE'
        ORDER BY gg.group_id, gg.permission,
                 permission_rank(gg.permission) DESC,
                 ((gg.source->>'kind') IN ('direct', 'role')) DESC`,
      [actorId],
    );
    const docs = await query<{
      target_id: string;
      target_name: string;
      permission: Permission;
      source: PermissionSource;
    }>(
      `SELECT DISTINCT ON (ad.document_id, ad.permission)
                ad.document_id AS target_id, d.title AS target_name, ad.permission, ad.source
         FROM accessible_documents($1, 'READ') ad
         JOIN documents d ON d.id = ad.document_id
        ORDER BY ad.document_id, ad.permission, permission_rank(ad.permission) DESC`,
      [actorId],
    );
    return [
      ...groups.map((r) => ({
        targetKind: 'group' as const,
        targetId: r.target_id,
        targetName: r.target_name,
        permission: r.permission,
        source: r.source,
      })),
      ...docs.map((r) => ({
        targetKind: 'document' as const,
        targetId: r.target_id,
        targetName: r.target_name,
        permission: r.permission,
        source: r.source,
      })),
    ].sort(
      (a, b) =>
        a.targetKind.localeCompare(b.targetKind) ||
        a.targetName.localeCompare(b.targetName) ||
        PERMISSION_RANK[b.permission] - PERMISSION_RANK[a.permission],
    );
  }
}
