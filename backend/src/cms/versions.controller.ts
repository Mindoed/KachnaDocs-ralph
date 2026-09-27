import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@kachnadocs/shared';
import { diffLines, summarize } from './diff';
import { PermissionService } from '../acl/permission.service';
import { RequirePermission } from '../acl/require-permission.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { query, withTransaction } from '../db';
import { notFound, validationFailed } from '../http-errors';

interface VersionRow {
  number: number;
  title: string;
  author_id: string | null;
  author_name: string | null;
  comment: string | null;
  published_at: Date;
}

interface HeadingNode {
  type?: string;
  attrs?: { anchor?: unknown; level?: unknown };
  content?: HeadingNode[];
  text?: unknown;
}

/**
 * Collect heading nodes for the `headings` table (PLAN.md §2.4). Anchors are
 * read from the node's attrs — they were assigned when the heading was created
 * and are never derived from its text — so publishing preserves the anchors a
 * draft already carries and `/documents/:slug#anchor` keeps resolving.
 */
export function extractHeadings(body: unknown): Array<{ anchor: string; level: number; text: string }> {
  const textOf = (node: HeadingNode): string =>
    typeof node.text === 'string' ? node.text : (node.content ?? []).map(textOf).join('');
  const found: Array<{ anchor: string; level: number; text: string }> = [];
  const walk = (node: HeadingNode | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'heading') {
      const anchor = typeof node.attrs?.anchor === 'string' ? node.attrs.anchor : null;
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      // An anchor-less heading is a draft the editor has not stamped yet; it
      // still gets a row, addressed by an ordinal anchor so the outline stays
      // addressable. The editor's own anchors are never overwritten.
      found.push({ anchor: anchor ?? `h-${found.length + 1}`, level, text: textOf(node) });
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(body as HeadingNode);
  return found;
}

/**
 * Publishing, version history, and restore-as-draft (SPEC.md §1).
 *
 * The rule the whole file is built around (PLAN.md §2.3): a version is a
 * self-contained snapshot — ProseMirror JSON + rendered Markdown + the title at
 * publish time — written once and never touched again. Nothing here replays Yjs
 * history, and nothing here UPDATEs `document_versions`; the immutability
 * trigger in migration 1740000005000 makes that an error rather than a
 * convention.
 *
 * Publishing needs MANAGE. SPEC.md §1 lists read/edit/publish/manage as four
 * distinct capabilities against three permission ranks, and MANAGE is the only
 * rank left to map "publish" onto — publishing is what makes content visible to
 * readers, which is an act of administration, not of editing. `forbidden()`'s
 * doc comment in http-errors.ts already assumed this mapping.
 */
@ApiTags('documents')
@Controller('documents')
export class VersionsController {
  constructor(private readonly permissions: PermissionService) {}

  /**
   * Snapshot the current draft as a new immutable version.
   *
   * The row lock on the document serialises concurrent publishes, so two
   * editors publishing at once get version N and N+1 rather than both computing
   * N and one of them dying on the (document_id, number) unique index.
   */
  @Post(':id/publish')
  @RequirePermission('MANAGE', 'document')
  async publish(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body() body: { comment?: string },
  ): Promise<unknown> {
    const comment = body?.comment?.trim() || null;
    const published = await withTransaction(async (client) => {
      // Locking read: also the ACL re-check, so a grant revoked mid-request
      // cannot publish.
      const doc = await client.query<{ title: string; draft_body: unknown; draft_markdown: string | null }>(
        `SELECT title, draft_body, draft_markdown FROM documents
          WHERE id = $1 AND can_access_document($2, id, 'MANAGE')
          FOR UPDATE`,
        [id, me.id],
      );
      const row = doc.rows[0];
      if (!row) throw notFound();

      const next = await client.query<{ n: number | null }>(
        'SELECT max(number)::int AS n FROM document_versions WHERE document_id = $1',
        [id],
      );
      const number = (next.rows[0]?.n ?? 0) + 1;

      const version = await client.query<{ id: string }>(
        `INSERT INTO document_versions (document_id, number, title, body, markdown, author_id, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [id, number, row.title, JSON.stringify(row.draft_body), row.draft_markdown ?? '', me.id, comment],
      );
      const versionId = version.rows[0];
      if (!versionId) throw notFound();

      const headings = extractHeadings(row.draft_body);
      for (const [ord, h] of headings.entries()) {
        await client.query(
          `INSERT INTO headings (version_id, anchor, level, text, ord)
           VALUES ($1, $2, $3, $4, $5)`,
          [versionId.id, h.anchor, h.level, h.text, ord],
        );
      }

      // The draft stays exactly as it was — publishing does not consume it.
      await client.query(`UPDATE documents SET state = 'Published', updated_at = now() WHERE id = $1`, [id]);
      return number;
    });
    return { published: true, version: published };
  }

  /** History list (SPEC.md §1: author, time, optional comment). Newest first. */
  @Get(':id/versions')
  @RequirePermission('READ', 'document')
  async history(@CurrentUser() me: AuthUser, @Param('id') id: string): Promise<unknown[]> {
    const rows = await query<VersionRow>(
      `SELECT v.number, v.title, v.author_id, u.display_name AS author_name, v.comment, v.published_at
         FROM document_versions v
         JOIN documents d ON d.id = v.document_id
         LEFT JOIN users u ON u.id = v.author_id
        WHERE v.document_id = $1 AND can_access_document($2, d.id, 'READ')
        ORDER BY v.number DESC`,
      [id, me.id],
    );
    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      authorId: r.author_id,
      authorName: r.author_name,
      comment: r.comment,
      publishedAt: r.published_at,
    }));
  }

  /** One snapshot in full, headings included: renderable with no Yjs present. */
  @Get(':id/versions/:number')
  @RequirePermission('READ', 'document')
  async one(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Param('number') number: string,
  ): Promise<unknown> {
    const wanted = Number(number);
    if (!Number.isInteger(wanted) || wanted < 1)
      throw validationFailed({ number: 'must be a version number' });
    const [row] = await query<VersionRow & { body: unknown; markdown: string }>(
      `SELECT v.number, v.title, v.body, v.markdown, v.author_id, u.display_name AS author_name,
              v.comment, v.published_at
         FROM document_versions v
         JOIN documents d ON d.id = v.document_id
         LEFT JOIN users u ON u.id = v.author_id
        WHERE v.document_id = $1 AND v.number = $2 AND can_access_document($3, d.id, 'READ')`,
      [id, wanted, me.id],
    );
    if (!row) throw notFound();
    const headings = await query<{ anchor: string; level: number; text: string; ord: number }>(
      `SELECT h.anchor, h.level, h.text, h.ord FROM headings h
         JOIN document_versions v ON v.id = h.version_id
        WHERE v.document_id = $1 AND v.number = $2
        ORDER BY h.ord`,
      [id, wanted],
    );
    return {
      number: row.number,
      title: row.title,
      body: row.body,
      markdown: row.markdown,
      authorId: row.author_id,
      authorName: row.author_name,
      comment: row.comment,
      publishedAt: row.published_at,
      headings,
    };
  }

  /**
   * Diff an older version against what a reader sees now (SPEC.md §1: "porovnat
   * ji s aktuální verzí"). Served from the backend so the comparison itself is
   * testable and the frontend only renders lines.
   *
   * `?to=N` compares two published versions; without it the target is the
   * caller's own draft when they hold WRITE, and the newest published version
   * otherwise. A writer editing a draft is told "current" means their draft; a
   * reader's "current" is the published head — which is exactly the draft/public
   * split SPEC.md §1 asks for, so the two must not silently share one endpoint
   * meaning.
   */
  @Get(':id/versions/:number/diff')
  @RequirePermission('READ', 'document')
  async diff(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Param('number') number: string,
    @Query('to') to?: string,
  ): Promise<unknown> {
    const from = Number(number);
    if (!Number.isInteger(from) || from < 1) throw validationFailed({ number: 'must be a version number' });
    const wantedTo = to === undefined ? null : Number(to);
    if (wantedTo !== null && (!Number.isInteger(wantedTo) || wantedTo < 1)) {
      throw validationFailed({ to: 'must be a version number' });
    }

    const [source] = await query<{ number: number; markdown: string; title: string }>(
      `SELECT v.number, v.markdown, v.title
         FROM document_versions v JOIN documents d ON d.id = v.document_id
        WHERE v.document_id = $1 AND v.number = $2 AND can_access_document($3, d.id, 'READ')`,
      [id, from, me.id],
    );
    if (!source) throw notFound();

    // Resolve the target side. A draft target needs WRITE, so a reader's diff
    // can never expose unpublished text.
    let targetRef: string;
    let targetMarkdown: string;
    if (wantedTo !== null) {
      const [target] = await query<{ number: number; markdown: string }>(
        `SELECT v.number, v.markdown
           FROM document_versions v JOIN documents d ON d.id = v.document_id
          WHERE v.document_id = $1 AND v.number = $2 AND can_access_document($3, d.id, 'READ')`,
        [id, wantedTo, me.id],
      );
      if (!target) throw notFound();
      targetRef = `v${target.number}`;
      targetMarkdown = target.markdown;
    } else {
      const [draft] = await query<{ markdown: string | null }>(
        `SELECT d.draft_markdown AS markdown FROM documents d
          WHERE d.id = $1 AND can_access_document($2, d.id, 'WRITE')`,
        [id, me.id],
      );
      if (draft) {
        targetRef = 'draft';
        targetMarkdown = draft.markdown ?? '';
      } else {
        // No WRITE: fall back to the published head, which is that reader's
        // "current". Absent entirely (never published) is a 404 like any other.
        const [head] = await query<{ number: number; markdown: string }>(
          `SELECT v.number, v.markdown
             FROM document_versions v JOIN documents d ON d.id = v.document_id
            WHERE v.document_id = $1
              AND v.number = (SELECT max(number) FROM document_versions WHERE document_id = $1)
              AND can_access_document($2, d.id, 'READ')`,
          [id, me.id],
        );
        if (!head) throw notFound();
        targetRef = `v${head.number}`;
        targetMarkdown = head.markdown;
      }
    }

    const lines = diffLines(source.markdown, targetMarkdown);
    return { from: `v${source.number}`, to: targetRef, summary: summarize(lines), lines };
  }

  /**
   * Restore an older version **as a new draft** (SPEC.md §1) — WRITE, not
   * MANAGE, because it changes nothing a reader can see: the published versions
   * and the document's state are left exactly as they are. Restoring in place is
   * impossible by construction; there is no code path that writes to
   * `document_versions` after insert.
   */
  @Post(':id/versions/:number/restore')
  @RequirePermission('WRITE', 'document')
  async restore(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Param('number') number: string,
  ): Promise<unknown> {
    const wanted = Number(number);
    if (!Number.isInteger(wanted) || wanted < 1)
      throw validationFailed({ number: 'must be a version number' });
    const [row] = await query<{ title: string; body: unknown; markdown: string }>(
      `SELECT v.title, v.body, v.markdown
         FROM document_versions v
         JOIN documents d ON d.id = v.document_id
        WHERE v.document_id = $1 AND v.number = $2 AND can_access_document($3, d.id, 'WRITE')`,
      [id, wanted, me.id],
    );
    if (!row) throw notFound();

    const [updated] = await query<{ state: string }>(
      `UPDATE documents
          SET draft_body = $2, draft_markdown = $3, draft_updated_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING state`,
      [id, JSON.stringify(row.body), row.markdown],
    );
    if (!updated) throw notFound();
    return { restored: true, number: wanted, state: updated.state };
  }
}
