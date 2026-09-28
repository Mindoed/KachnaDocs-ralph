import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { ResolvedHeadingDto } from '@kachnadocs/shared';
import { INACCESSIBLE_DOCUMENT_ID } from '../src/cms/headings';
import { query } from '../src/db';
import { doc, group, http, loginAs, resetDatabase, startServer, stopServer } from './helpers';

/**
 * Cross-document reference resolution (PLAN §2.5) over real HTTP.
 *
 * The property under test is that a reference is a *pointer*, never a copy: the
 * text returned is the target's current published heading, looked up per reader at
 * request time. Three things follow, and each gets its own test because they fail
 * independently — a cache could be live but global, or per-reader but snapshotted.
 *
 *  - live: republishing the target changes what every referrer sees;
 *  - per-reader: the same ref resolves for Carl and is withheld from Bona, who
 *    cannot read the target;
 *  - draft is never disclosed: an unpublished target yields no text at all, so a
 *    link cannot be used to read a colleague's unfinished work.
 *
 * Withheld means withheld completely — no title, no slug, and a document id that
 * is valid but not the target's — because this response is handed to every client
 * joined to the *referring* document. "Exists but you may not see it" is the one
 * fact PLAN §3.3 refuses to leak, and it leaks just as easily through a JSON field
 * as through a response code.
 */
let bona = '';
let carl = '';
let ana = '';

beforeAll(async () => {
  await startServer();
  await resetDatabase();
  [bona, carl, ana] = await Promise.all([loginAs('bona'), loginAs('carl'), loginAs('ana')]);
});

afterAll(async () => {
  await stopServer();
});

async function resolve(refs: string[], token: string): Promise<ResolvedHeadingDto[]> {
  const qs = refs.map((r) => `ref=${encodeURIComponent(r)}`).join('&');
  const res = await http.get(`/headings/resolve?${qs}`, token);
  if (res.status !== 200) throw new Error(`resolve failed: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { headings: ResolvedHeadingDto[] }).headings;
}

function first(headings: ResolvedHeadingDto[]): ResolvedHeadingDto {
  const row = headings[0];
  if (!row) throw new Error('expected one resolved heading, got none');
  return row;
}

describe('resolving a reference to another document', () => {
  it('returns the target heading text from its newest published version', async () => {
    // The runbook is published and Carl holds a direct READ grant on it.
    const row = first(await resolve([`${doc('runbook')}#sec-1`], carl));
    expect(row.target).toBe('ok');
    expect(row.text).toBe('Obsah');
    expect(row.level).toBe(1);
    expect(row.version).toBe(1);
    expect(row.slug).toBeTruthy();
  });

  it('accepts the slug as well as the id, and resolves them to the same document', async () => {
    const res = await http.get(`/documents/${doc('runbook')}`, carl);
    const slug = String((res.body as { slug: string }).slug);
    expect(slug).toBeTruthy();

    const byId = first(await resolve([`${doc('runbook')}#sec-1`], carl));
    const bySlug = first(await resolve([`${slug}#sec-1`], carl));
    // Same document, same text: the editor can store whichever a human typed
    // without the read path caring which.
    expect(bySlug.documentId).toBe(byId.documentId);
    expect(bySlug.text).toBe(byId.text);
  });

  it('answers every reference in one request, in the order they were asked for', async () => {
    const headings = await resolve(
      [`${doc('runbook')}#sec-1`, `${doc('handbook')}#sec-1`, `${doc('runbook')}#sec-1`],
      bona,
    );
    expect(headings).toHaveLength(3);
    // Bona can read the runbook and not the handbook, so the three answers must
    // come back as ok / withheld / ok. A positional zip against the SQL rows —
    // which come back in whatever order the planner picks — would scramble this.
    expect(headings[0]?.documentId).toBe(doc('runbook'));
    expect(headings[1]?.target).toBe('inaccessible');
    expect(headings[2]?.documentId).toBe(doc('runbook'));
  });

  it('requires a signed-in caller', async () => {
    const res = await http.get(`/headings/resolve?ref=${doc('runbook')}%23sec-1`);
    // 401, not an empty list: an anonymous caller has no reader to evaluate the
    // ACL against, so "everything is inaccessible" would be a confident lie about
    // documents that are perfectly readable.
    expect(res.status).toBe(401);
  });

  it('answers an empty query with an empty list', async () => {
    const res = await http.get('/headings/resolve', carl);
    expect(res.status).toBe(200);
    expect((res.body as { headings: unknown[] }).headings).toEqual([]);
  });
});

describe('a target the reader cannot READ', () => {
  it('withholds the title, the slug and the document id', async () => {
    // The handbook is HR; Bona holds nothing on it.
    const row = first(await resolve([`${doc('handbook')}#sec-1`], bona));
    expect(row.target).toBe('inaccessible');
    expect(row.title).toBeNull();
    expect(row.slug).toBeNull();
    expect(row.text).toBeNull();
    expect(row.version).toBeNull();
    // Not the real id, and not empty either: a zero uuid keeps the shape of a
    // document reference so a client cannot branch on "there is something here".
    expect(row.documentId).toBe(INACCESSIBLE_DOCUMENT_ID);
    expect(row.documentId).not.toBe(doc('handbook'));
    // The anchor survives, because it is the *referring* document's own content —
    // the reader already has it, and keeping it preserves the link's shape.
    expect(row.anchor).toBe('sec-1');
  });

  it('is indistinguishable from a reference to a document that never existed', async () => {
    const denied = first(await resolve([`${doc('handbook')}#sec-1`], bona));
    const ghost = first(await resolve(['no-such-document-anywhere#sec-1'], bona));
    // Byte-identical apart from nothing at all: this is the whole leak, asserted
    // directly. An editor that could tell these apart could walk the corpus and
    // enumerate documents by probing links.
    expect(ghost).toEqual(denied);
  });

  it('depends on the reader, not on the document', async () => {
    // Same ref, two callers, opposite answers. A global cache keyed by (document,
    // anchor) — the obvious way to make this endpoint fast — produces one answer
    // for everyone, which is either a leak or a denial of access.
    const carlSees = first(await resolve([`${doc('runbook')}#sec-1`], carl));
    const anaSees = first(await resolve([`${doc('runbook')}#sec-1`], ana));
    expect(carlSees.target).toBe('ok');
    expect(carlSees.text).toBe('Obsah');
    expect(anaSees.target).toBe('inaccessible');
    expect(anaSees.text).toBeNull();
  });

  it('honours a document-level NONE override', async () => {
    // Ana's HR role grants inherited READ on HR; an explicit NONE on salaries
    // takes it away (SPEC.md:82). Resolution goes through the same SQL function,
    // so the override has to reach here too.
    const viaRole = first(await resolve([`${doc('handbook')}#sec-1`], ana));
    const overridden = first(await resolve([`${doc('salaries')}#sec-1`], ana));
    expect(viaRole.target).toBe('ok');
    expect(overridden.target).toBe('inaccessible');
  });
});

describe('an unpublished target', () => {
  it('yields no text, so a link cannot read someone else’s draft', async () => {
    // privateIdea is draft-only and its draft text is a real sentence.
    const draftText = await query<{ draft_markdown: string }>(
      'SELECT draft_markdown FROM documents WHERE id = $1',
      [doc('privateIdea')],
    );
    const unpublished = draftText[0]?.draft_markdown ?? '';
    expect(unpublished.length).toBeGreaterThan(0);

    // Bona holds WRITE here, so READ too — this is not a permission denial.
    const row = first(await resolve([`${doc('privateIdea')}#sec-1`], bona));
    expect(row.target).toBe('ok');
    expect(row.text).toBeNull();
    expect(row.version).toBeNull();
    // The assertion that matters: nothing in the response carries the draft. A
    // resolution that fell back to draft_body when no version exists would be the
    // quiet ACL bypass this endpoint exists to avoid.
    const response = JSON.stringify(await resolve([`${doc('privateIdea')}#sec-1`], bona));
    expect(response).not.toContain(unpublished.trim());
  });
});

describe('a reference stays live across the target’s next publish', () => {
  it('shows the target’s new heading text once it is republished', async () => {
    // A document of Bona's own, so she can publish it, referring to a second
    // document she also controls.
    const target = await http.post(
      '/documents',
      { title: 'Cílová kapitola', groupId: group('engineering') },
      bona,
    );
    const targetId = (target.body as { id: string }).id;
    const ref = `${targetId}#krok-1`;

    await http.put(
      `/documents/${targetId}/draft`,
      headingDraft('krok-1', 'Nasazení v pátek', 'první text'),
      bona,
    );
    await http.post(`/documents/${targetId}/publish`, { comment: 'první' }, bona);
    expect(first(await resolve([ref], bona)).text).toBe('Nasazení v pátek');

    // Republish with the heading reworded. Nothing touches the referring side —
    // there is nothing to touch, which is the point: it stores a pointer.
    await http.put(
      `/documents/${targetId}/draft`,
      headingDraft('krok-1', 'Nasazení v pondělí', 'druhý text'),
      bona,
    );
    const republished = await http.post(`/documents/${targetId}/publish`, { comment: 'druhá' }, bona);
    expect(republished.status).toBe(201);
    expect((republished.body as { version: number }).version).toBe(2);

    const after = first(await resolve([ref], bona));
    expect(after.text).toBe('Nasazení v pondělí');
    expect(after.version).toBe(2);
    expect(after.target).toBe('ok');
  });

  it('reports no text once the heading itself is gone from the newest version', async () => {
    const target = await http.post(
      '/documents',
      { title: 'Mizející kapitola', groupId: group('engineering') },
      bona,
    );
    const targetId = (target.body as { id: string }).id;
    const ref = `${targetId}#zmizi`;

    await http.put(`/documents/${targetId}/draft`, headingDraft('zmizi', 'Byla tu', 'a'), bona);
    await http.post(`/documents/${targetId}/publish`, {}, bona);
    expect(first(await resolve([ref], bona)).text).toBe('Byla tu');

    // Version 2 has no heading at all.
    await http.put(
      `/documents/${targetId}/draft`,
      {
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bez hlavičky' }] }],
        },
        markdown: 'bez hlavičky',
      },
      bona,
    );
    await http.post(`/documents/${targetId}/publish`, {}, bona);

    const row = first(await resolve([ref], bona));
    // The document is still readable and its identity is still disclosed — the
    // reader can open it — but the section they linked to no longer exists, and
    // that is the honest message rather than a stale quote.
    expect(row.documentId).toBe(targetId);
    expect(row.text).toBeNull();
    expect(row.target).toBe('ok');
  });
});

/** A draft body carrying one anchored heading, for the publish tests. */
function headingDraft(
  anchor: string,
  heading: string,
  text: string,
): {
  body: unknown;
  markdown: string;
} {
  return {
    body: {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { anchor, level: 1 },
          content: [{ type: 'text', text: heading }],
        },
        { type: 'paragraph', content: [{ type: 'text', text }] },
      ],
    },
    markdown: `# ${heading} {data-anchor="${anchor}"}\n\n${text}`,
  };
}
