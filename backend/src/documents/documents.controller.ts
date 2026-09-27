import { Controller, Get, Param } from '@nestjs/common';
import type { AuthUser, DocumentState } from '@kachnadocs/shared';
import { PermissionService } from '../acl/permission.service';
import { RequirePermission } from '../acl/require-permission.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { query } from '../db';
import { notFound } from '../http-errors';

interface DocumentRow {
  id: string;
  slug: string;
  title: string;
  state: DocumentState;
  group_id: string;
  group_name: string;
  owner_role_id: string | null;
  owner_role_name: string | null;
}

/**
 * Deliberately the smallest read path that is still a *real* one. Phase 2 owns
 * drafts, versions and body content; this exists so phase 1 can prove SPEC.md §3
 * at the HTTP layer — "the UI hides the button" is not a thing an e2e test can
 * check, but an unauthorized GET is.
 *
 * Both routes filter in SQL. The single-document read does not ask
 * "can they access it, then fetch it"; it puts the ACL predicate in the WHERE
 * clause, so a missing row and a forbidden row come back as the same 404 and
 * there is no branch left to get wrong.
 */
@Controller('documents')
export class DocumentsController {
  constructor(private readonly permissions: PermissionService) {}

  private static rowToDto(row: DocumentRow) {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      state: row.state,
      group: { id: row.group_id, name: row.group_name },
      // SPEC.md:95 prefers a Discord role as owner; surfacing it is also what
      // makes the e2e suite able to assert the fixture really is role-owned.
      ownerRole: row.owner_role_id ? { id: row.owner_role_id, name: row.owner_role_name } : null,
    };
  }

  /** Documents the caller may READ. Rows they cannot see are never returned. */
  @Get()
  async list(@CurrentUser() me: AuthUser): Promise<unknown[]> {
    const filter = this.permissions.documentsFilter(me.id, 'READ', { offset: 0 });
    const rows = await query<DocumentRow>(
      `SELECT d.id, d.slug, d.title, d.state, d.group_id, g.name AS group_name,
              d.owner_role_id, r.name AS owner_role_name
         FROM documents d
         JOIN groups g ON g.id = d.group_id
         LEFT JOIN discord_roles r ON r.id = d.owner_role_id
         ${filter.sql}
        ORDER BY d.title`,
      filter.params,
    );
    return rows.map(DocumentsController.rowToDto);
  }

  // The guard checks READ and answers 404 on failure; the query repeats the
  // predicate so the read is ACL-filtered in SQL regardless of the guard.
  @Get(':id')
  @RequirePermission('READ', 'document')
  async one(@CurrentUser() me: AuthUser, @Param('id') id: string): Promise<unknown> {
    const rows = await query<DocumentRow>(
      `SELECT d.id, d.slug, d.title, d.state, d.group_id, g.name AS group_name,
              d.owner_role_id, r.name AS owner_role_name
         FROM documents d
         JOIN groups g ON g.id = d.group_id
         LEFT JOIN discord_roles r ON r.id = d.owner_role_id
        WHERE d.id = $1
          AND can_access_document($2, d.id, 'READ')`,
      [id, me.id],
    );
    const row = rows[0];
    if (!row) throw notFound();
    return DocumentsController.rowToDto(row);
  }
}
