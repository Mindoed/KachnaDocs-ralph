import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@kachnadocs/shared';
import { PermissionService } from '../acl/permission.service';
import { RequirePermission } from '../acl/require-permission.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { query, withTransaction } from '../db';
import { notFound, validationFailed } from '../http-errors';

interface GroupRow {
  id: string;
  parent_id: string | null;
  name: string;
  n_documents: string;
}

/**
 * Groups are the ACL's only inheriting container (phase 1), so these routes
 * are permission-critical in a way ordinary tree CRUD is not: reparenting a
 * group silently changes which documents hundreds of grants reach, because
 * inheritance is resolved at read time from this very parent_id column.
 *
 * Consequences encoded below:
 *  - editing a group requires MANAGE on it, never mere WRITE;
 *  - reparenting rejects cycles in SQL (walk up from the proposed parent);
 *  - the creator of a group receives a MANAGE grant on it, so the tree cannot
 *    grow unreachable — and SPEC.md:95's "prefer a role as owner" is honored
 *    by accepting ownerRoleId on creation.
 */
@ApiTags('groups')
@Controller('groups')
export class GroupsController {
  constructor(private readonly permissions: PermissionService) {}

  private static dto(row: GroupRow) {
    return {
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      documentCount: Number(row.n_documents),
    };
  }

  /**
   * Groups the caller can READ, as a flat list — the tree is assembled client-side.
   *
   * The document count is ACL-filtered, because an unfiltered one is a leak: a
   * group the caller can read but whose documents they mostly cannot would report
   * "3 documents" next to an empty list, which discloses that hidden documents
   * exist. PLAN.md §3.3 forbids exactly that, and it is observable — Ana sees
   * Payroll counted 1 while `GET /documents` returned her nothing from it, because
   * her `NONE` override on that one document hides it from her listing but not
   * from a bare `count(*)`. Counting what the caller may READ makes the number
   * agree with the list it sits beside.
   */
  @Get()
  async list(@CurrentUser() me: AuthUser): Promise<unknown[]> {
    // offset 1 because the actor id is passed ahead of the filter's own two
    // parameters; the count subquery takes $1 and the filter becomes $2/$3.
    // Passing offset 0 would make $2 mean "the required permission" inside the
    // subquery — a uuid cast failure at best, a wrong ACL binding at worst,
    // which is the trap documentsFilter's doc comment warns about.
    const filter = this.permissions.groupsFilter(me.id, 'READ', { offset: 1 });
    const rows = await query<GroupRow>(
      `SELECT g.id, g.parent_id, g.name,
              (SELECT count(*)::text FROM documents d
                WHERE d.group_id = g.id AND can_access_document($1, d.id, 'READ')) AS n_documents
         FROM groups g ${filter.sql}
        ORDER BY g.name`,
      [me.id, ...filter.params],
    );
    return rows.map(GroupsController.dto);
  }

  @Post()
  async create(
    @CurrentUser() me: AuthUser,
    @Body() body: { name?: string; parentId?: string | null; ownerRoleId?: string | null },
  ): Promise<unknown> {
    const name = body?.name?.trim();
    if (!name) throw validationFailed({ name: 'required' });
    const parentId = body?.parentId ?? null;

    if (parentId) {
      if (!(await this.permissions.canAccessGroup(me.id, parentId, 'MANAGE'))) throw notFound();
    } else {
      // Top-level groups reshape the whole hierarchy, so only someone who
      // already manages something may create one.
      const effective = await this.permissions.effectiveForUser(me.id);
      if (!effective.some((g) => g.permission === 'MANAGE')) throw notFound();
    }

    // Owner: explicit role if given (SPEC.md:95), else the creator personally —
    // a group nobody can manage after creation would be a trap.
    const owner = body?.ownerRoleId
      ? { kind: 'role' as const, id: body.ownerRoleId }
      : { kind: 'user' as const, id: me.id };
    const subjectColumn = owner.kind === 'role' ? 'subject_role_id' : 'subject_user_id';

    // Not destructured: withTransaction yields the single row or undefined, and
    // `const [row]` would try to iterate a non-iterable.
    const row = await withTransaction(async (client) => {
      const inserted = await client.query<GroupRow>(
        `INSERT INTO groups (parent_id, name) VALUES ($1, $2)
         RETURNING id, parent_id, name, '0' AS n_documents`,
        [parentId, name],
      );
      const created = inserted.rows[0];
      if (!created) throw notFound();
      await client.query(
        `INSERT INTO permissions (${subjectColumn}, target_group_id, permission)
         VALUES ($1, $2, 'MANAGE')`,
        [owner.id, created.id],
      );
      return created;
    });
    if (!row) throw notFound();
    return GroupsController.dto(row);
  }

  @Patch(':id')
  @RequirePermission('MANAGE', 'group')
  async update(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body() body: { name?: string; parentId?: string | null },
  ): Promise<unknown> {
    const name = body?.name?.trim();
    // "Reparenting" means the field was sent with a value. An omitted field must
    // not move anything, and in particular must not silently promote a group to
    // top level — so presence alone is not enough, `undefined` counts as absent.
    const reparent = body?.parentId !== undefined;
    if (!name && !reparent) throw validationFailed({ name: 'name or parentId required' });

    // typeof rather than `reparent && !== null`, which does not narrow away
    // undefined and so would not type-check below.
    if (typeof body.parentId === 'string') {
      if (body.parentId === id) throw validationFailed({ parentId: 'a group cannot be its own parent' });
      // A cycle would make the recursive grant resolution loop forever, so the
      // proposed parent may not be this group or any of its descendants.
      const cyclic = await query<{ one: number }>(
        `WITH RECURSIVE descendants AS (
           SELECT id FROM groups WHERE id = $1
           UNION ALL
           SELECT g.id FROM groups g JOIN descendants d ON g.parent_id = d.id
         )
         SELECT 1::int AS one FROM descendants WHERE id = $2`,
        [id, body.parentId],
      );
      if (cyclic.length > 0) throw validationFailed({ parentId: 'would create a cycle' });
      if (!(await this.permissions.canAccessGroup(me.id, body.parentId, 'MANAGE'))) throw notFound();
    }

    // CTE rather than UPDATE ... RETURNING with a correlated subquery: the
    // count must reflect the row *after* the write, and RETURNING's visibility
    // rules for sibling rows are not something to rely on by memory.
    //
    // ACL-filtered like the list, for a narrower case than GET /groups: managing
    // a group does not imply reading every document in it, so a manager holding a
    // NONE override would otherwise be shown a count that includes the document
    // they are denied.
    const [row] = await query<GroupRow>(
      `WITH updated AS (
         UPDATE groups
            SET name = COALESCE($2, name),
                parent_id = CASE WHEN $3::boolean THEN $4 ELSE parent_id END
          WHERE id = $1
          RETURNING id, parent_id, name
       )
       SELECT u.id, u.parent_id, u.name,
              (SELECT count(*)::text FROM documents d
                WHERE d.group_id = u.id AND can_access_document($5, d.id, 'READ')) AS n_documents
         FROM updated u`,
      [id, name ?? null, reparent, reparent ? (body.parentId ?? null) : null, me.id],
    );
    if (!row) throw notFound();
    return GroupsController.dto(row);
  }

  /**
   * Deleting a group cascades: its categories, documents, versions and grants
   * all go with it (ON DELETE CASCADE). That is why this requires MANAGE and
   * not WRITE. SPEC.md §1 asks for delete; there is no recycle bin yet, so the
   * destruction is real and immediate.
   */
  @Delete(':id')
  @RequirePermission('MANAGE', 'group')
  async remove(@CurrentUser() _me: AuthUser, @Param('id') id: string): Promise<{ deleted: boolean }> {
    // Refuse rather than silently swallow a whole subtree the caller may not
    // expect to lose: a group with children must be emptied first.
    const children = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM groups WHERE parent_id = $1',
      [id],
    );
    if ((children[0]?.n ?? 0) > 0) throw validationFailed({ id: 'group still has child groups' });
    await query('DELETE FROM groups WHERE id = $1', [id]);
    return { deleted: true };
  }
}
