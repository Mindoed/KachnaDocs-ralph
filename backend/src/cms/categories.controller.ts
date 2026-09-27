import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@kachnadocs/shared';
import { PermissionService } from '../acl/permission.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { query } from '../db';
import { notFound, validationFailed } from '../http-errors';

interface CategoryRow {
  id: string;
  group_id: string;
  name: string;
  position: number;
  n_documents: string;
}

/**
 * Categories are the middle level of SPEC.md §1's hierarchy (group > category >
 * document). They are *not* an ACL target: a category is visible exactly where
 * its group is, so permission checks always happen on the group and
 * accessible_groups stays the single resolution path. ralph/DEFERRED.md records
 * why per-category grants are deliberately absent.
 */
@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly permissions: PermissionService) {}

  private static dto(row: CategoryRow) {
    return {
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      position: row.position,
      documentCount: Number(row.n_documents),
    };
  }

  /** Categories inside groups the caller may READ. */
  @Get()
  async list(@CurrentUser() me: AuthUser): Promise<unknown[]> {
    // The filter applies to the category's group, so name the column rather
    // than post-processing the generated SQL.
    const filter = this.permissions.groupsFilter(me.id, 'READ', { column: 'c.group_id', offset: 0 });
    const rows = await query<CategoryRow>(
      `SELECT c.id, c.group_id, c.name, c.position,
              (SELECT count(*)::text FROM documents d WHERE d.category_id = c.id) AS n_documents
         FROM categories c
         ${filter.sql}
        ORDER BY c.group_id, c.position, c.name`,
      filter.params,
    );
    return rows.map(CategoriesController.dto);
  }

  @Post()
  async create(
    @CurrentUser() me: AuthUser,
    @Body() body: { name?: string; groupId?: string; position?: number },
  ): Promise<unknown> {
    const name = body?.name?.trim();
    const groupId = body?.groupId;
    if (!name || !groupId) throw validationFailed({ name: 'name and groupId are required' });
    if (!(await this.permissions.canAccessGroup(me.id, groupId, 'WRITE'))) throw notFound();

    const [row] = await query<CategoryRow>(
      `INSERT INTO categories (group_id, name, position) VALUES ($1, $2, $3)
       RETURNING id, group_id, name, position, '0' AS n_documents`,
      [groupId, name, body.position ?? 0],
    );
    if (!row) throw notFound();
    return CategoriesController.dto(row);
  }

  @Patch(':id')
  async update(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body() body: { name?: string; position?: number; groupId?: string },
  ): Promise<unknown> {
    const existing = await query<{ group_id: string }>('SELECT group_id FROM categories WHERE id = $1', [id]);
    const current = existing[0];
    if (!current) throw notFound();
    if (!(await this.permissions.canAccessGroup(me.id, current.group_id, 'WRITE'))) throw notFound();

    // Moving between groups needs WRITE on both, for the same reason documents
    // do: otherwise a writer can relocate content out of reach.
    if (body.groupId && body.groupId !== current.group_id) {
      if (!(await this.permissions.canAccessGroup(me.id, body.groupId, 'WRITE'))) throw notFound();
    }

    const name = body?.name?.trim();
    const [row] = await query<CategoryRow>(
      `WITH updated AS (
         UPDATE categories
            SET name = COALESCE($2, name),
                position = COALESCE($3, position),
                group_id = COALESCE($4, group_id)
          WHERE id = $1
          RETURNING id, group_id, name, position
       )
       SELECT u.id, u.group_id, u.name, u.position,
              (SELECT count(*)::text FROM documents d WHERE d.category_id = u.id) AS n_documents
         FROM updated u`,
      [id, name ?? null, body.position ?? null, body.groupId ?? null],
    );
    if (!row) throw notFound();
    return CategoriesController.dto(row);
  }

  /**
   * Deleting a category is safe by construction: documents.category_id is
   * ON DELETE SET NULL, so the documents survive and simply attach to the group.
   */
  @Delete(':id')
  async remove(@CurrentUser() me: AuthUser, @Param('id') id: string): Promise<{ deleted: boolean }> {
    const existing = await query<{ group_id: string }>('SELECT group_id FROM categories WHERE id = $1', [id]);
    const current = existing[0];
    if (!current) throw notFound();
    if (!(await this.permissions.canAccessGroup(me.id, current.group_id, 'WRITE'))) throw notFound();

    await query('DELETE FROM categories WHERE id = $1', [id]);
    return { deleted: true };
  }
}
