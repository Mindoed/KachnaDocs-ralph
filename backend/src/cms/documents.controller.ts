import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser, DocumentState } from '@kachnadocs/shared';
import { PermissionService } from '../acl/permission.service';
import { RequirePermission } from '../acl/require-permission.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { query, withTransaction } from '../db';
import { notFound, validationFailed } from '../http-errors';

interface DocumentRow {
  id: string;
  slug: string;
  title: string;
  state: DocumentState;
  group_id: string;
  group_name: string;
  category_id: string | null;
  category_name: string | null;
  owner_role_id: string | null;
  owner_role_name: string | null;
  position: number;
  latest_version: number | null;
}

interface ContentRow {
  number: number;
  title: string;
  body: unknown;
  markdown: string;
  published_at: Date;
}

/**
 * One projection and one FROM clause, shared by every document read, so a
 * column can never be selected in one query and joined in another. Aliases are
 * fixed (`d`, `g`, `c`, `r`); a write path that wants its own source aliases
 * renames them via `withSource`.
 */
const SELECT = `d.id, d.slug, d.title, d.state, d.group_id, g.name AS group_name,
        d.category_id, c.name AS category_name, d.position,
        d.owner_role_id, r.name AS owner_role_name,
        (SELECT max(v.number)::int FROM document_versions v WHERE v.document_id = d.id) AS latest_version`;

const FROM = `FROM documents d
         JOIN groups g ON g.id = d.group_id
         LEFT JOIN categories c ON c.id = d.category_id
         LEFT JOIN discord_roles r ON r.id = d.owner_role_id`;

/** Read a document row by id, ACL-prefixed. The only way this file fetches one. */
async function loadDocument(actorId: string, id: string): Promise<DocumentRow | undefined> {
  const rows = await query<DocumentRow>(
    `SELECT ${SELECT} ${FROM}
      WHERE d.id = $1 AND can_access_document($2, d.id, 'READ')`,
    [id, actorId],
  );
  return rows[0];
}

/** Slug from a title, Czech diacritics folded, with a numeric tail on collision. */
export function slugify(title: string): string {
  const base = title
    .normalize('NFD')
    // Combining marks left by NFD; without this "Úřední" slugifies to empty.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.length > 0 ? base : 'dokument';
}

/**
 * Documents: reads, and the phase-2 write paths (create, rename, move,
 * archive, restore, delete, draft editing).
 *
 * Reads put the ACL predicate in the WHERE clause rather than asking "can they
 * access it, then fetch it", so a missing row and a forbidden row come back as
 * the same 404 and there is no branch left to get wrong.
 *
 * Draft vs published is the load-bearing distinction (SPEC.md §1: "běžný
 * čtenář vidí pouze publikovanou verzi"). Published content is readable with
 * READ; the draft body requires WRITE. Publish and history live in
 * `versions.controller.ts`.
 */
@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly permissions: PermissionService) {}

  private static dto(row: DocumentRow) {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      state: row.state,
      groupId: row.group_id,
      groupName: row.group_name,
      categoryId: row.category_id,
      categoryName: row.category_name,
      position: row.position,
      // SPEC.md:95 prefers a Discord role as owner; surfacing it is also what
      // lets the e2e suite assert the fixture really is role-owned.
      ownerRole: row.owner_role_id ? { id: row.owner_role_id, name: row.owner_role_name } : null,
      latestVersion: row.latest_version,
    };
  }

  /** Documents the caller may READ. Rows they cannot see are never returned. */
  @Get()
  async list(@CurrentUser() me: AuthUser): Promise<unknown[]> {
    const filter = this.permissions.documentsFilter(me.id, 'READ', { offset: 0 });
    const rows = await query<DocumentRow>(
      `SELECT ${SELECT} ${FROM} ${filter.sql} ORDER BY d.title`,
      filter.params,
    );
    return rows.map(DocumentsController.dto);
  }

  // The guard checks READ and answers 404 on failure; the query repeats the
  // predicate so the read stays SQL-filtered regardless of the guard.
  @Get(':id')
  @RequirePermission('READ', 'document')
  async one(@CurrentUser() me: AuthUser, @Param('id') id: string): Promise<unknown> {
    const row = await loadDocument(me.id, id);
    if (!row) throw notFound();
    return DocumentsController.dto(row);
  }

  /**
   * The body. Default and `?ref=published` return the newest published snapshot
   * and need READ; `?ref=draft` needs WRITE, which is what enforces "readers see
   * only the published version"; `?ref=N` opens an older version.
   */
  @Get(':id/content')
  async content(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Query('ref') ref?: string,
  ): Promise<unknown> {
    if (ref === 'draft') {
      // WRITE before anything is fetched, then the read is still SQL-prefixed.
      if (!(await this.permissions.canAccessDocument(me.id, id, 'WRITE'))) throw notFound();
      const rows = await query<{ title: string; body: unknown; markdown: string | null }>(
        `SELECT d.title, d.draft_body AS body, d.draft_markdown AS markdown
           FROM documents d
          WHERE d.id = $1 AND can_access_document($2, d.id, 'WRITE')`,
        [id, me.id],
      );
      const row = rows[0];
      if (!row) throw notFound();
      return { ref: 'draft', number: null, title: row.title, body: row.body, markdown: row.markdown };
    }

    const version = ref === undefined || ref === 'published' ? null : Number(ref);
    if (version !== null && !Number.isInteger(version)) {
      throw validationFailed({ ref: 'must be "published", "draft", or a version number' });
    }

    const rows = await query<ContentRow>(
      `SELECT v.number, v.title, v.body, v.markdown, v.published_at
         FROM document_versions v
         JOIN documents d ON d.id = v.document_id
        WHERE v.document_id = $1
          AND ($2::int IS NULL OR v.number = $2)
          AND ($2::int IS NOT NULL OR v.number = (SELECT max(number) FROM document_versions WHERE document_id = $1))
          AND can_access_document($3, d.id, 'READ')`,
      [id, version, me.id],
    );
    const row = rows[0];
    // Never published, or no such version: both indistinguishable from "no READ",
    // which is the point.
    if (!row) throw notFound();
    return { ref: 'published', ...row };
  }

  @Post()
  async create(
    @CurrentUser() me: AuthUser,
    @Body()
    body: {
      title?: string;
      groupId?: string;
      categoryId?: string | null;
      slug?: string;
      ownerRoleId?: string | null;
    },
  ): Promise<unknown> {
    const title = body?.title?.trim();
    const groupId = body?.groupId;
    if (!title || !groupId) throw validationFailed({ title: 'title and groupId are required' });
    // Creating inside a group is an edit to that group's subtree.
    if (!(await this.permissions.canAccessGroup(me.id, groupId, 'WRITE'))) throw notFound();

    const categoryId = body.categoryId ?? null;
    if (categoryId) await this.assertCategoryInGroup(categoryId, groupId);

    const root = slugify(body.slug?.trim() || title);
    const inserted = await withTransaction(async (client) => {
      // Slugs are globally unique, so pick the first free candidate rather than
      // trusting a caller-supplied one.
      let candidate = root;
      for (let n = 2; ; n += 1) {
        const clash = await client.query<{ one: number }>(
          'SELECT 1::int AS one FROM documents WHERE slug = $1',
          [candidate],
        );
        // client.query returns a QueryResult, unlike this file's query() helper.
        if (clash.rows.length === 0) break;
        candidate = `${root}-${n}`;
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO documents (group_id, category_id, slug, title, state, owner_role_id,
                               draft_body, draft_markdown, draft_updated_at)
         VALUES ($1, $2, $3, $4, 'Draft', $5, $6, $7, now())
         RETURNING id`,
        [
          groupId,
          categoryId,
          candidate,
          title,
          // SPEC.md:95 — an owning role if the caller named one, else no owner
          // rather than defaulting ownership to a person.
          body.ownerRoleId ?? null,
          // An empty doc rather than null, so the shape clients receive does not
          // change depending on whether anything has been typed yet.
          JSON.stringify({ type: 'doc', content: [] }),
          '',
        ],
      );
      return result.rows[0];
    });
    if (!inserted) throw notFound();

    const row = await loadDocument(me.id, inserted.id);
    if (!row) throw notFound();
    return DocumentsController.dto(row);
  }

  /**
   * Rename, move (regroup and/or recategorize), reorder, archive, restore.
   * Any of these needs WRITE; moving additionally needs WRITE on the
   * destination, since otherwise a writer could relocate a document somewhere
   * their grants no longer reach and lose it, or park it in a group they do not
   * belong to.
   */
  @Patch(':id')
  @RequirePermission('WRITE', 'document')
  async update(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body()
    body: {
      title?: string;
      groupId?: string;
      categoryId?: string | null;
      position?: number;
      state?: DocumentState;
    },
  ): Promise<unknown> {
    const title = body?.title?.trim();
    if (body.state && !['Draft', 'Published', 'Archived'].includes(body.state)) {
      throw validationFailed({ state: 'must be Draft, Published or Archived' });
    }
    if (body.groupId && !(await this.permissions.canAccessGroup(me.id, body.groupId, 'WRITE')))
      throw notFound();

    if ('categoryId' in (body ?? {}) && body.categoryId) {
      // The guard already proved the caller may write this document, so a
      // missing group means the row is gone rather than a permission failure.
      const targetGroup = body.groupId ?? (await this.currentGroup(id));
      if (!targetGroup) throw notFound();
      await this.assertCategoryInGroup(body.categoryId, targetGroup, id);
    }
    // A document moved out of a category that belonged to its old group would
    // otherwise keep a category pointing at a group it is no longer in.
    const clearCategory = body.groupId !== undefined && !('categoryId' in (body ?? {}));

    const [row] = await query<DocumentRow>(
      `WITH updated AS (
         UPDATE documents
            SET title = COALESCE($2, title),
                group_id = COALESCE($3, group_id),
                category_id = CASE
                  WHEN $4::boolean THEN $5
                  WHEN $8::boolean THEN NULL
                  ELSE category_id
                END,
                position = COALESCE($6, position),
                state = COALESCE($7, state),
                updated_at = now()
          WHERE id = $1
          RETURNING id, slug, title, state, group_id, category_id, position,
                    owner_role_id, created_at, updated_at
       )
       SELECT ${SELECT.replace(/\bd\./g, 'u.')}
         FROM updated u
         JOIN groups g ON g.id = u.group_id
         LEFT JOIN categories c ON c.id = u.category_id
         LEFT JOIN discord_roles r ON r.id = u.owner_role_id`,
      [
        id,
        title ?? null,
        body.groupId ?? null,
        'categoryId' in (body ?? {}),
        body.categoryId ?? null,
        body.position ?? null,
        body.state ?? null,
        clearCategory,
      ],
    );
    if (!row) throw notFound();
    return DocumentsController.dto(row);
  }

  /**
   * Permanent: versions and headings follow by ON DELETE CASCADE, so published
   * history is destroyed with the document. That is why this is MANAGE rather
   * than WRITE. SPEC.md §1 asks for delete and there is no recycle bin yet.
   */
  @Delete(':id')
  @RequirePermission('MANAGE', 'document')
  async remove(@CurrentUser() _me: AuthUser, @Param('id') id: string): Promise<{ deleted: boolean }> {
    await query('DELETE FROM documents WHERE id = $1', [id]);
    return { deleted: true };
  }

  /** Save the working copy. Requires WRITE; leaves every published version alone. */
  @Put(':id/draft')
  @RequirePermission('WRITE', 'document')
  async saveDraft(
    @CurrentUser() _me: AuthUser,
    @Param('id') id: string,
    @Body() body: { body?: unknown; markdown?: string },
  ): Promise<{ saved: boolean }> {
    if (body?.body === undefined || typeof body.markdown !== 'string') {
      throw validationFailed({ body: 'body and markdown are required' });
    }
    await query(
      `UPDATE documents SET draft_body = $2, draft_markdown = $3, draft_updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(body.body), body.markdown],
    );
    return { saved: true };
  }

  private async currentGroup(id: string): Promise<string | undefined> {
    const rows = await query<{ group_id: string }>('SELECT group_id FROM documents WHERE id = $1', [id]);
    return rows[0]?.group_id;
  }

  /** A category is only valid for a document that sits in the category's group. */
  private async assertCategoryInGroup(
    categoryId: string,
    groupId: string,
    documentId?: string,
  ): Promise<void> {
    const rows = await query<{ one: number }>(
      'SELECT 1::int AS one FROM categories WHERE id = $1 AND group_id = $2',
      [categoryId, groupId],
    );
    if (rows.length === 0) {
      throw validationFailed({ categoryId: 'must belong to the document group', document: documentId });
    }
  }
}
