import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { ApiErrorBody } from '@kachnadocs/shared';
import { GHOST_ID, doc, group, http, loginAs, resetDatabase, startServer, stopServer, user } from './helpers';

/**
 * SPEC.md §1's versioning half over real HTTP: publish, history, open an older
 * version, diff, and restore-as-draft.
 *
 * Two invariants shape every assertion. A published snapshot never changes, so
 * the tests re-read it after every operation that could plausibly have rewritten
 * it. And a reader's "current" is the published head while a writer's is their
 * draft, so several tests run the same request as both Carl (READ only) and Bona
 * (WRITE/MANAGE) and expect different answers — that divergence is the feature.
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

const code = (body: unknown): string => (body as ApiErrorBody).error?.code ?? '';
const data = (body: unknown): Record<string, unknown> => body as Record<string, unknown>;
const list = (body: unknown): Record<string, unknown>[] => body as Record<string, unknown>[];
/**
 * First element with a loud failure instead of an undefined index. Strict
 * indexing makes `rows[0].x` a type error everywhere, and a thrown message
 * ("expected at least one row") reads better in a failure report than
 * "Cannot read properties of undefined".
 */
function firstRow(rows: Record<string, unknown>[]): Record<string, unknown> {
  const row = rows[0];
  if (!row) throw new Error('expected at least one row, got none');
  return row;
}

/** Markdown body with one paragraph, matching the seed's shape. */
function body(text: string): { body: unknown; markdown: string } {
  return {
    body: {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { anchor: 'a-1', level: 1 },
          content: [{ type: 'text', text: 'Kapitola' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text }] },
      ],
    },
    markdown: `# Kapitola {data-anchor="a-1"}\n\n${text}\n`,
  };
}

async function newDocument(title: string): Promise<string> {
  const res = await http.post('/documents', { title, groupId: group('engineering') }, bona);
  expect(res.status).toBe(201);
  return data(res.body).id as string;
}

async function saveDraft(id: string, text: string, token = bona): Promise<void> {
  const res = await http.put(`/documents/${id}/draft`, body(text), token);
  expect(res.status).toBe(200);
}

async function publish(id: string, comment?: string): Promise<number> {
  const res = await http.post(`/documents/${id}/publish`, comment ? { comment } : {}, bona);
  expect(res.status).toBe(201);
  return data(res.body).version as number;
}

async function publishedText(id: string, ref = 'published', token = bona): Promise<string> {
  const res = await http.get(`/documents/${id}/content?ref=${ref}`, token);
  expect(res.status).toBe(200);
  return data(res.body).markdown as string;
}

describe('publishing', () => {
  it('creates a version snapshot and leaves the draft untouched', async () => {
    const id = await newDocument('Publikační test');
    await saveDraft(id, 'První text.');

    const first = await publish(id, 'První publikace');
    expect(first).toBe(1);

    // The snapshot holds what the draft held at publish time...
    expect(await publishedText(id)).toContain('První text.');
    // ...and the draft survives publication unchanged, ready for more editing.
    const draft = await http.get(`/documents/${id}/content?ref=draft`, bona);
    expect(data(draft.body).markdown).toContain('První text.');

    const history = await http.get(`/documents/${id}/versions`, bona);
    expect(list(history.body)).toHaveLength(1);
    expect(data(firstRow(list(history.body))).comment).toBe('První publikace');
  });

  it('numbers versions consecutively and stamps author, time and comment', async () => {
    const id = await newDocument('Dvě publikace');
    await saveDraft(id, 'Revize nula.');
    expect(await publish(id, 'Základ')).toBe(1);
    await saveDraft(id, 'Revize jedna.');
    expect(await publish(id, 'Oprava překlepů')).toBe(2);

    const history = await http.get(`/documents/${id}/versions`, bona);
    const rows = list(history.body);
    // Newest first: the panel reads like a changelog.
    expect(rows.map((r) => r.number)).toEqual([2, 1]);
    // The author column must resolve through users, not just echo an id: the
    // panel shows a name. Asserting the id plus a non-empty name pins the join
    // without hardcoding the dev provider's display string, which is fixture
    // detail this test has no business depending on.
    expect(firstRow(rows).authorId).toBe(user('bona'));
    expect(firstRow(rows).authorName).toEqual(expect.any(String));
    expect(String(firstRow(rows).authorName)).not.toBe('');
    expect(firstRow(rows).comment).toBe('Oprava překlepů');
    expect(typeof firstRow(rows).publishedAt).toBe('string');
    expect(new Date(firstRow(rows).publishedAt as string).getTime()).not.toBeNaN();
  });

  it('flips the document state to Published and reports the head version', async () => {
    const id = await newDocument('Stav po publikaci');
    await saveDraft(id, 'Text.');
    expect(data((await http.get(`/documents/${id}`, bona)).body).state).toBe('Draft');
    await publish(id);
    const after = data((await http.get(`/documents/${id}`, bona)).body);
    expect(after.state).toBe('Published');
    expect(after.latestVersion).toBe(1);
  });

  it('keeps the title taken at publish time when the document is renamed later', async () => {
    const id = await newDocument('Původní název');
    await saveDraft(id, 'Obsah.');
    await publish(id);
    await http.patch(`/documents/${id}`, { title: 'Nový název' }, bona);

    const version = await http.get(`/documents/${id}/versions/1`, bona);
    expect(data(version.body).title).toBe('Původní název');
    expect(data((await http.get(`/documents/${id}`, bona)).body).title).toBe('Nový název');
  });

  it('records heading anchors with the version so #anchor links resolve', async () => {
    const id = await newDocument('Nadpisy');
    await saveDraft(id, 'Odstavec.');
    await publish(id);
    const version = data((await http.get(`/documents/${id}/versions/1`, bona)).body);
    expect(version.headings).toEqual([{ anchor: 'a-1', level: 1, text: 'Kapitola', ord: 0 }]);
  });

  it('publishes an untouched draft as a real snapshot', async () => {
    // A document nobody has typed into yet: publishing it is legal (an empty
    // published document is a legitimate state) and must still produce a
    // self-contained snapshot rather than an error or a null body.
    const id = await newDocument('Prázdný dokument');
    expect(await publish(id)).toBe(1);
    const version = data((await http.get(`/documents/${id}/versions/1`, bona)).body);
    expect(version.body).toEqual({ type: 'doc', content: [] });
    expect(version.markdown).toBe('');
    expect(version.headings).toEqual([]);
  });
});

describe('published snapshots are immutable through every path', () => {
  it('offers no route that mutates a version', async () => {
    const id = await newDocument('Neměnná verze');
    await saveDraft(id, 'Původní.');
    await publish(id);
    const before = await publishedText(id, '1');

    // There is no PUT/PATCH/DELETE on /documents/:id/versions/:number, so a
    // client trying one gets 404. Asserting the route is absent is what keeps a
    // later iteration from adding one by accident.
    for (const method of ['patch', 'put'] as const) {
      const res = await http[method](`/documents/${id}/versions/1`, { markdown: 'přepsáno' }, bona);
      expect([404, 405]).toContain(res.status);
    }
    expect(await publishedText(id, '1')).toBe(before);
  });

  it('leaves v1 byte-identical after v2 is published and after a restore', async () => {
    const id = await newDocument('Starší verze žije dál');
    await saveDraft(id, 'Verze jedna.');
    await publish(id, 'v1');
    const v1 = await publishedText(id, '1');

    await saveDraft(id, 'Verze dvě.');
    await publish(id, 'v2');
    expect(await publishedText(id, '1')).toBe(v1);

    await http.post(`/documents/${id}/versions/1/restore`, {}, bona);
    expect(await publishedText(id, '1')).toBe(v1);
    expect(await publishedText(id, '2')).toContain('Verze dvě.');
  });
});

describe('draft is invisible to readers', () => {
  it('serves a reader the published text while an editor edits the draft', async () => {
    const id = doc('runbook');
    // Carl holds READ only; Bona holds WRITE and MANAGE through Engineering.
    const before = await publishedText(id, 'published', carl);
    expect(before).toContain('Kroky nasazení.');

    await saveDraft(id, 'Nasazuje se v pátek ve 3.');
    expect(await publishedText(id, 'published', carl)).toBe(before);
    // ...and the editor does see their own work.
    expect(await publishedText(id, 'draft', bona)).toContain('Nasazuje se v pátek ve 3.');
  });

  it('refuses the draft to a reader and to a reader who cannot even see it', async () => {
    for (const token of [carl, ana]) {
      const res = await http.get(`/documents/${doc('runbook')}/content?ref=draft`, token);
      expect(res.status).toBe(404);
      expect(code(res.body)).toBe('not_found');
    }
  });

  it('refuses a save from a reader and leaves the draft byte-identical', async () => {
    const id = doc('runbook');
    const before = data((await http.get(`/documents/${id}/content?ref=draft`, bona)).body).markdown;
    const res = await http.put(`/documents/${id}/draft`, body('Psaní bez oprávnění.'), carl);
    expect(res.status).toBe(404);
    expect(data((await http.get(`/documents/${id}/content?ref=draft`, bona)).body).markdown).toBe(before);
  });

  it('holds the reader/writer split on the seeded fixture itself', async () => {
    // Ana READs the handbook through her HR role but cannot WRITE it, so she
    // must see the published text and be denied the draft — the two sides of
    // SPEC.md §1's "běžný čtenář vidí pouze publikovanou verzi" in one document.
    const published = await http.get(`/documents/${doc('handbook')}/content`, ana);
    expect(published.status).toBe(200);
    expect(data(published.body).markdown).toContain('Základní pravidla/personálu.');
    expect(data(published.body).markdown).not.toContain('Koncept úprav.');
    const draft = await http.get(`/documents/${doc('handbook')}/content?ref=draft`, ana);
    expect(draft.status).toBe(404);
  });
});

describe('diff', () => {
  it('reports the change between an older version and the current draft', async () => {
    const id = await newDocument('Diff proti konceptu');
    await saveDraft(id, 'Původní odstavec.');
    await publish(id);
    await saveDraft(id, 'Přepracovaný odstavec.');

    const res = await http.get(`/documents/${id}/versions/1/diff`, bona);
    expect(res.status).toBe(200);
    const diff = data(res.body);
    expect(diff.from).toBe('v1');
    expect(diff.to).toBe('draft');
    expect(diff.summary).toEqual({ added: 1, removed: 1, unchanged: 2 });
    const lines = list(diff.lines);
    expect(lines.filter((l) => l.op === 'remove').map((l) => l.text)).toEqual(['Původní odstavec.']);
    expect(lines.filter((l) => l.op === 'add').map((l) => l.text)).toEqual(['Přepracovaný odstavec.']);
  });

  it('diffs two published versions when asked by number', async () => {
    const id = await newDocument('Diff verzí');
    await saveDraft(id, 'Jedna.');
    await publish(id);
    await saveDraft(id, 'Dvě.');
    await publish(id);

    const res = await http.get(`/documents/${id}/versions/1/diff?to=2`, bona);
    expect(data(res.body).to).toBe('v2');
    expect(data(res.body).summary).toEqual({ added: 1, removed: 1, unchanged: 2 });
  });

  it("compares against the published head for a reader, never someone else's draft", async () => {
    const id = doc('runbook');
    await saveDraft(id, 'Koncept, který čtenář nesmí vidět.');
    const res = await http.get(`/documents/${id}/versions/1/diff`, carl);
    expect(res.status).toBe(200);
    expect(data(res.body).to).toBe('v1');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('nesmí vidět');
  });

  it('reports no changes for identical text', async () => {
    const id = await newDocument('Shodné verze');
    await saveDraft(id, 'Stejný text.');
    await publish(id);
    await publish(id);
    const res = await http.get(`/documents/${id}/versions/1/diff?to=2`, bona);
    expect(data(res.body).summary).toEqual({ added: 0, removed: 0, unchanged: 3 });
  });
});

describe('restore as a new draft', () => {
  it('round-trips: restore v1, publish, content equals v1 and history gains a head', async () => {
    const id = await newDocument('Obnova verze');
    await saveDraft(id, 'Původní obsah.');
    await publish(id, 'v1');
    const v1 = await publishedText(id, '1');

    await saveDraft(id, 'Něco úplně jiného.');
    await publish(id, 'v2');
    expect(await publishedText(id)).not.toBe(v1);

    const restored = await http.post(`/documents/${id}/versions/1/restore`, {}, bona);
    expect(restored.status).toBe(201);
    expect(data(restored.body).restored).toBe(true);
    // Restoring writes the snapshot into the draft; the published head is v2.
    expect(await publishedText(id)).not.toBe(v1);
    expect(data((await http.get(`/documents/${id}`, bona)).body).latestVersion).toBe(2);

    expect(await publishedText(id, 'draft')).toBe(v1);
    const third = await publish(id, 'Obnova z v1');
    expect(third).toBe(3);
    expect(await publishedText(id)).toBe(v1);

    const history = list((await http.get(`/documents/${id}/versions`, bona)).body);
    expect(history.map((h) => h.number)).toEqual([3, 2, 1]);
    expect(firstRow(history).comment).toBe('Obnova z v1');
  });

  it('does not disturb the published head or rewind state', async () => {
    const id = await newDocument('Obnova nedestruktivní');
    await saveDraft(id, 'První.');
    await publish(id);
    await saveDraft(id, 'Druhá.');
    await publish(id);
    const headBefore = await publishedText(id);

    await http.post(`/documents/${id}/versions/1/restore`, {}, bona);
    expect(await publishedText(id)).toBe(headBefore);
    expect(data((await http.get(`/documents/${id}`, bona)).body).state).toBe('Published');
  });

  it('is refused for a reader, and leaves the draft alone', async () => {
    const id = doc('runbook');
    const draftBefore = data((await http.get(`/documents/${id}/content?ref=draft`, bona)).body).markdown;
    const res = await http.post(`/documents/${id}/versions/1/restore`, {}, carl);
    expect(res.status).toBe(404);
    expect(code(res.body)).toBe('not_found');
    expect(data((await http.get(`/documents/${id}/content?ref=draft`, bona)).body).markdown).toBe(
      draftBefore,
    );
  });
});

describe('version ACL', () => {
  it('denies publish to a writer who is not a manager, indistinguishably from absence', async () => {
    // Bona created a document in Engineering but Carl only ever reads the
    // runbook: both answers must be the same 404 body.
    const missing = await http.post(`/documents/${GHOST_ID}/publish`, {}, bona);
    const denied = await http.post(`/documents/${doc('runbook')}/publish`, {}, carl);
    expect(denied.status).toBe(missing.status);
    expect(denied.body).toEqual(missing.body);
  });

  it('makes history, single version and diff unreadable without READ', async () => {
    const id = doc('salaries');
    // Ana is explicitly denied this document (SPEC.md:82) despite her HR role.
    for (const path of [
      `/documents/${id}/versions`,
      `/documents/${id}/versions/1`,
      `/documents/${id}/versions/1/diff`,
    ]) {
      const res = await http.get(path, ana);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
    }
  });

  it('answers a signed-out caller with 401 rather than leaking version content', async () => {
    const res = await http.get(`/documents/${doc('runbook')}/versions`);
    expect(res.status).toBe(401);
  });

  it('404s a version number that does not exist, in the same shape as no permission', async () => {
    const missing = await http.get(`/documents/${doc('runbook')}/versions/99`, carl);
    const forbidden = await http.get(`/documents/${doc('salaries')}/versions/1`, ana);
    expect(missing.status).toBe(404);
    expect(forbidden.status).toBe(404);
    expect(missing.body).toEqual(forbidden.body);
  });

  it('rejects a non-numeric version rather than coercing it', async () => {
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const res = await http.get(`/documents/${doc('runbook')}/versions/${bad}`, carl);
      expect(res.status).toBe(400);
      expect(code(res.body)).toBe('validation_failed');
    }
  });

  it('404s versions of a document that has none', async () => {
    // Never published: no rows, and that must look like no READ.
    const res = await http.get(`/documents/${doc('privateIdea')}/versions/1`, bona);
    expect(res.status).toBe(404);
  });

  /**
   * The other direction, and the one that makes the denials above mean
   * something: grant the capability and the same call succeeds. Without it, a
   * publish route that 404'd for everyone would pass this whole file.
   *
   * Last in the suite and undone afterwards, because a grant visible to other
   * tests would quietly turn their "reader cannot publish" assertions vacuous.
   */
  it('publishes once the actor is granted MANAGE, and stops when the grant is revoked', async () => {
    const granted = await http.post(
      '/permissions',
      {
        subjectKind: 'user',
        subjectId: user('carl'),
        targetKind: 'document',
        targetId: doc('runbook'),
        permission: 'MANAGE',
      },
      bona,
    );
    expect(granted.status).toBe(201);
    const grantId = data(granted.body).id as string;

    const before = list((await http.get(`/documents/${doc('runbook')}/versions`, bona)).body).length;
    const published = await http.post(
      `/documents/${doc('runbook')}/publish`,
      { comment: 'Carl smí publikovat' },
      carl,
    );
    expect(published.status).toBe(201);
    expect(data(published.body).version).toBe(before + 1);
    const history = list((await http.get(`/documents/${doc('runbook')}/versions`, bona)).body);
    expect(firstRow(history).authorId).toBe(user('carl'));

    const removed = await http.del(`/permissions/${grantId}`, bona);
    expect(removed.status).toBe(200);
    const again = await http.post(`/documents/${doc('runbook')}/publish`, {}, carl);
    expect(again.status).toBe(404);
  });
});
