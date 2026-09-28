import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser, ResolvedHeadingDto } from '@kachnadocs/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { query } from '../db';
import { inaccessibleReference } from './headings';

/**
 * Resolving cross-document heading references (PLAN §2.5).
 *
 * A reference stores *where* it points — a document and an anchor — and never
 * what it points at. The text is looked up here, per request, per reader,
 * against the target's newest **published** version. That is what makes a
 * reference live: republish the target with a renamed heading and every document
 * referring to it shows the new wording on next load, with nothing to crawl and
 * no copies to update. The alternative the plan rejects is pasting a snapshot of
 * the target's text into the referring document, which quietly becomes a lie the
 * moment the target is republished.
 *
 * Published content only, never the target's draft. A reader with READ on
 * document A must not obtain unpublished text from document B by linking into it,
 * which would be an ACL bypass through content the reader never asked for.
 *
 * A target the reader cannot READ resolves to `inaccessibleReference()`: no
 * title, no slug, and a valid-but-meaningless document id. The result of this
 * endpoint reaches every client joined to the *referring* document through the
 * editor, so it is handled with the same care as a websocket frame — PLAN §3.3
 * does not exempt a value because it arrived in a JSON field.
 */
@ApiTags('documents')
@Controller('headings')
export class ReferencesController {
  /**
   * `GET /headings/resolve?ref=<document>#<anchor>`, repeated.
   *
   * One request for a document's whole set of references rather than one per
   * reference: a page with six links issuing six requests would resolve the same
   * corpus at six different moments, so a target republished mid-load would render
   * text from two generations. One query is one snapshot of that truth, and it
   * bounds the round trips an editor makes on open.
   *
   * No `@RequirePermission`: the permission being enforced belongs to each
   * *target*, which varies per ref and is decided in SQL, and the decorator can
   * only name a route parameter. The route is still not public — the global guard
   * defaults to deny, so a caller without a token gets the uniform 401 rather than
   * a body in which every reference has been resolved to "inaccessible", which
   * would be a response worth refusing rather than returning.
   */
  @Get('resolve')
  async resolve(
    @CurrentUser() me: AuthUser,
    @Query('ref') raw: string | string[] | undefined,
  ): Promise<{ headings: ResolvedHeadingDto[] }> {
    const refs = parseRefs(raw);
    if (refs.length === 0) return { headings: [] };

    // Slugs and uuids are both accepted, because that is what a document link
    // looks like in practice: hand-written ones use the slug, links the editor
    // inserts use the id. An unresolvable token produces no row and so resolves
    // inaccessible, the same outcome as a target that was deleted.
    const tokens = Array.from(new Set(refs.map((r) => r.document)));
    const idRows = await query<{ id: string; token: string }>(
      `SELECT d.id::text AS id, t.token
         FROM unnest($1::text[]) AS t(token)
         JOIN documents d ON d.slug = t.token OR d.id::text = t.token`,
      [tokens],
    );
    const idByToken = new Map(idRows.map((r) => [r.token, r.id]));
    const documentIds = Array.from(new Set(idRows.map((r) => r.id)));
    if (documentIds.length === 0) {
      return { headings: refs.map((r) => inaccessibleReference(r.anchor)) };
    }

    // One row per distinct (document, anchor) pair, unnested positionally.
    const pairs = distinctPairs(refs, idByToken);
    const rows = await query<ResolvedRow>(
      `WITH latest AS (
         -- Newest published version per target. DISTINCT ON rides the
         -- (document_id, number DESC) index instead of a correlated subquery.
         SELECT DISTINCT ON (v.document_id)
                v.id AS version_id, v.document_id, v.number AS version, v.title
           FROM document_versions v
          WHERE v.document_id = ANY($1::uuid[])
          ORDER BY v.document_id, v.number DESC
       )
       SELECT d.id::text                          AS document_id,
              w.anchor                            AS anchor,
              d.slug                              AS slug,
              l.title                             AS title,
              h.level                             AS level,
              h.text                              AS text,
              l.version                           AS version,
              -- Decided per target, in SQL, by the same function every read path
              -- uses. Filtering this in TypeScript from a list the client could
              -- fetch separately is the leak this file exists to avoid.
              can_access_document($4, d.id, 'READ') AS allowed
         FROM unnest($2::uuid[], $3::text[]) AS w(document_id, anchor)
         JOIN documents d ON d.id = w.document_id
         LEFT JOIN latest l ON l.document_id = d.id
         LEFT JOIN headings h ON h.version_id = l.version_id AND h.anchor = w.anchor`,
      [documentIds, pairs.map((p) => p.documentId), pairs.map((p) => p.anchor), me.id],
    );

    // Keyed, never zipped by index: `w` comes back in an order the planner picks,
    // so position would attach one target's title to another's link as soon as two
    // refs shared a document.
    const resolved = new Map<string, ResolvedHeadingDto>();
    for (const row of rows) {
      const key = keyOf(row.document_id, row.anchor);
      if (resolved.has(key)) continue;
      resolved.set(key, toDto(row));
    }

    return {
      headings: refs.map((ref) => {
        const id = idByToken.get(ref.document);
        // No such document or slug: indistinguishable from one the reader was
        // never granted, which is the point — an editor must not be able to
        // enumerate the corpus by probing links.
        if (!id) return inaccessibleReference(ref.anchor);
        return resolved.get(keyOf(id, ref.anchor)) ?? vanishedTarget(id, ref.anchor);
      }),
    };
  }
}

interface ResolvedRow {
  document_id: string;
  anchor: string;
  slug: string | null;
  title: string | null;
  level: number | null;
  text: string | null;
  version: number | null;
  allowed: boolean;
}

/**
 * A row of the join becomes a DTO.
 *
 * Three outcomes and they are not interchangeable:
 *  - denied -> the placeholder, identity withheld entirely;
 *  - readable but never published -> real identity, no text. The document is
 *    visible, it simply has no published version to quote yet, and hiding its
 *    title here would be a lie the reader can disprove by opening it;
 *  - readable and published -> current text and the version it came from, so the
 *    editor can say which generation it is showing.
 *
 * `allowed` is computed against the *document*, so it is never null; the nulls
 * distinguish the second case from the third.
 */
function toDto(row: ResolvedRow): ResolvedHeadingDto {
  if (!row.allowed) return inaccessibleReference(row.anchor);
  return {
    target: 'ok',
    documentId: row.document_id,
    slug: row.slug,
    title: row.title,
    anchor: row.anchor,
    level: row.level,
    text: row.text,
    version: row.version,
  };
}

/**
 * A readable target that produced no row.
 *
 * Which, by construction, should not happen: every pair sent to the second query
 * got its id from a join against `documents`, and that query drives the result, so
 * each pair yields exactly one row. The one way to reach here is for the target to
 * be **deleted between the two queries** — resolve the id, someone else hits
 * DELETE, the pair finds no document. Permanent and unhelpful.
 *
 * So this is the shape of a request that raced a deletion, and it reads as a link
 * whose target has gone: the reader keeps the id they already had (their own
 * document's content, not a disclosure) and gets no title and no text. It is not
 * `inaccessibleReference`, because nothing was denied — reporting a permission
 * problem that did not happen would send someone to ask a colleague for a grant
 * they already hold.
 *
 * A heading that merely no longer exists does NOT land here; it yields a row with
 * a null `text`, which `toDto` renders as identity-plus-no-text. That is the common
 * case and worth stating, because PLAN §2.4 makes anchors non-derivable: re-typing
 * a heading keeps its anchor, so the only way to lose one is to delete the node.
 */
function vanishedTarget(documentId: string, anchor: string): ResolvedHeadingDto {
  return {
    target: 'ok',
    documentId,
    slug: null,
    title: null,
    anchor,
    level: null,
    text: null,
    version: null,
  };
}

const keyOf = (documentId: string, anchor: string): string => `${documentId} ${anchor}`;

/**
 * Caller tokens become resolved document ids, one row per distinct pair.
 *
 * A token that did not resolve contributes nothing here — it is answered straight
 * from `idByToken` on the way out — and a pair listed twice is sent to Postgres
 * once, because the same target referenced by two links in one document is the
 * common case rather than an edge one.
 */
function distinctPairs(
  refs: Array<{ document: string; anchor: string }>,
  idByToken: Map<string, string>,
): Array<{ documentId: string; anchor: string }> {
  const seen = new Set<string>();
  const out: Array<{ documentId: string; anchor: string }> = [];
  for (const ref of refs) {
    const id = idByToken.get(ref.document);
    if (!id) continue;
    const key = keyOf(id, ref.anchor);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ documentId: id, anchor: ref.anchor });
  }
  return out;
}

/**
 * `<document>[#<anchor>]`, from repeated `?ref=` parameters.
 *
 * The anchor is optional because a reference to a whole document is legitimate;
 * it then resolves to the document's title with no quoted heading. Split on the
 * *first* `#` only: an anchor is a nanoid and cannot contain one, but a slug typed
 * by hand could, and mis-splitting it would resolve a real document as missing.
 */
function parseRefs(raw: string | string[] | undefined): Array<{ document: string; anchor: string }> {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out: Array<{ document: string; anchor: string }> = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const hash = value.indexOf('#');
    const document = hash === -1 ? value : value.slice(0, hash);
    const anchor = hash === -1 ? '' : value.slice(hash + 1);
    if (!document) continue;
    // Bounded, because this list becomes an unnest() over two parallel arrays and
    // an unbounded one lets a request allocate memory proportional to its URL.
    if (out.length >= 64) break;
    out.push({ document, anchor });
  }
  return out;
}
