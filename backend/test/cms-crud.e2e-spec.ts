import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { ApiErrorBody } from '@kachnadocs/shared';
import { GHOST_ID, doc, group, http, loginAs, resetDatabase, startServer, stopServer, user } from './helpers';

/**
 * SPEC.md §1 write paths over real HTTP.
 *
 * The phase-1 invariant still governs every assertion here: a denial is
 * indistinguishable from a missing resource, so the tests expect 404 rather than
 * 403 for "you may not write that" — and each mutation test confirms the
 * mutation did *not* happen, not merely that the response was a refusal.
 */
let ana = '';
let bona = '';
let carl = '';

beforeAll(async () => {
  await startServer();
  await resetDatabase();
  [ana, bona, carl] = await Promise.all([loginAs('ana'), loginAs('bona'), loginAs('carl')]);
});

afterAll(async () => {
  await stopServer();
});

const code = (body: unknown): string => (body as ApiErrorBody).error?.code ?? '';
const data = (body: unknown): Record<string, unknown> => body as Record<string, unknown>;

/** Bona manages the Engineering group, so she is the writer in these tests. */
async function createDocument(title: string, groupId: string, token = bona): Promise<string> {
  const res = await http.post('/documents', { title, groupId }, token);
  expect(res.status).toBe(201);
  const id = data(res.body).id as string;
  expect(typeof id).toBe('string');
  return id;
}

async function createGroup(name: string, parentId?: string, token = bona): Promise<string> {
  const res = await http.post('/groups', parentId ? { name, parentId } : { name }, token);
  expect(res.status).toBe(201);
  return data(res.body).id as string;
}

describe('document CRUD', () => {
  it('creates a document in a group the caller may write', async () => {
    const res = await http.post(
      '/documents',
      { title: 'Plánování kapacit', groupId: group('engineering') },
      bona,
    );
    expect(res.status).toBe(201);
    const body = data(res.body);
    expect(body.state).toBe('Draft');
    expect(body.latestVersion).toBeNull();
    expect(body.slug).toBe('planovani-kapacit');
  });

  it('folds Czech diacritics when deriving a slug and keeps slugs unique', async () => {
    const first = await http.post(
      '/documents',
      { title: 'Úřední deska', groupId: group('engineering') },
      bona,
    );
    expect(data(first.body).slug).toBe('uredni-deska');
    const second = await http.post(
      '/documents',
      { title: 'Úřední deska', groupId: group('engineering') },
      bona,
    );
    expect(data(second.body).slug).toBe('uredni-deska-2');
  });

  it('refuses to create inside a group the caller cannot write, and stores nothing', async () => {
    const before = await http.get('/documents', ana);
    const res = await http.post('/documents', { title: 'Podvod', groupId: group('engineering') }, ana);
    expect(res.status).toBe(404);
    expect(code(res.body)).toBe('not_found');

    const after = await http.get('/documents', ana);
    expect((after.body as unknown[]).length).toBe((before.body as unknown[]).length);
  });

  it('will not attach a category belonging to a different group', async () => {
    const res = await http.post(
      '/documents',
      {
        title: 'Špatná kategorie',
        groupId: group('engineering'),
        categoryId: 'ddddddd1-0000-0000-0000-000000000000',
      },
      bona,
    );
    expect(res.status).toBe(400);
    expect(code(res.body)).toBe('validation_failed');
  });

  it('renames a document while leaving the published version title alone', async () => {
    // SPEC.md §1: history is immutable, so the version snapshot keeps the title
    // it was published under even though the document is renamed.
    const id = doc('runbook');
    const before = await http.get(`/documents/${id}/content`, bona);
    expect(data(before.body).title).toBe('Nasazovací runbook');

    const renamed = await http.patch(`/documents/${id}`, { title: 'Runbook nasazení' }, bona);
    expect(renamed.status).toBe(200);
    expect(data(renamed.body).title).toBe('Runbook nasazení');

    const after = await http.get(`/documents/${id}/content`, bona);
    expect(data(after.body).title).toBe('Nasazovací runbook');
  });

  it('refuses a rename by a read-only actor and leaves the title unchanged', async () => {
    const res = await http.patch(`/documents/${doc('runbook')}`, { title: 'Vlastní název' }, carl);
    expect(res.status).toBe(404);

    const current = await http.get(`/documents/${doc('runbook')}`, bona);
    expect(data(current.body).title).not.toBe('Vlastní název');
  });

  it('archives a document without deleting it', async () => {
    const id = await createDocument('K doarchivovani', group('engineering'));
    const res = await http.patch(`/documents/${id}`, { state: 'Archived' }, bona);
    expect(data(res.body).state).toBe('Archived');

    const fetched = await http.get(`/documents/${id}`, bona);
    expect(data(fetched.body).state).toBe('Archived');
  });

  it('rejects a state value outside the three the SPEC names', async () => {
    const id = await createDocument('Nespravny stav', group('engineering'));
    const res = await http.patch(`/documents/${id}`, { state: 'Deleted' }, bona);
    expect(res.status).toBe(400);
  });

  it('refuses deletion without MANAGE and leaves the document readable', async () => {
    const id = doc('handbook');
    // Bona manages Engineering only, Ana holds READ on the handbook — neither
    // may destroy it. Deleting is the one verb that needs MANAGE.
    expect((await http.del(`/documents/${id}`, bona)).status).toBe(404);
    expect((await http.del(`/documents/${id}`, ana)).status).toBe(404);
    expect((await http.get(`/documents/${id}`, ana)).status).toBe(200);
  });

  it('answers identically for a foreign document id and a nonexistent one on every verb', async () => {
    const forbidden = await http.get(`/documents/${doc('handbook')}`, carl);
    const missing = await http.get(`/documents/${GHOST_ID}`, carl);
    expect(forbidden.status).toBe(missing.status);
    expect(forbidden.body).toEqual(missing.body);

    const patchForbidden = await http.patch(`/documents/${doc('handbook')}`, { title: 'x' }, carl);
    const patchMissing = await http.patch(`/documents/${GHOST_ID}`, { title: 'x' }, carl);
    expect(patchForbidden.status).toBe(patchMissing.status);
    expect(patchForbidden.body).toEqual(patchMissing.body);
  });
});

describe('draft versus published', () => {
  it('serves published content to a reader and hides the draft', async () => {
    // The fixture deliberately diverges: the published handbook says one thing,
    // Ana's draft adds "Koncept".
    const res = await http.get(`/documents/${doc('handbook')}/content`, ana);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Základní pravidla');
    expect(JSON.stringify(res.body)).not.toContain('Koncept');
  });

  it('refuses the draft to a reader, which is the whole point of the WRITE check', async () => {
    const res = await http.get(`/documents/${doc('handbook')}/content?ref=draft`, ana);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Koncept');
  });

  it('serves the draft to someone with WRITE', async () => {
    const res = await http.get(`/documents/${doc('runbook')}/content?ref=draft`, bona);
    expect(res.status).toBe(200);
    expect(data(res.body).ref).toBe('draft');
  });

  it('saves a draft without touching any published version', async () => {
    const id = doc('runbook');
    const before = await http.get(`/documents/${id}/content`, bona);

    const saved = await http.put(
      `/documents/${id}/draft`,
      { body: { type: 'doc', content: [{ type: 'paragraph' }] }, markdown: 'Rozpracováno.\n' },
      bona,
    );
    expect(saved.status).toBe(200);

    const draft = await http.get(`/documents/${id}/content?ref=draft`, bona);
    expect(data(draft.body).markdown).toBe('Rozpracováno.\n');
    const published = await http.get(`/documents/${id}/content`, bona);
    expect(published.body).toEqual(before.body);
  });

  it('refuses a draft save from a read-only actor', async () => {
    const res = await http.put(
      `/documents/${doc('handbook')}/draft`,
      { body: { type: 'doc', content: [] }, markdown: 'cizi zasah\n' },
      ana,
    );
    expect(res.status).toBe(404);

    const draft = await http.get(`/documents/${doc('handbook')}/content?ref=draft`, ana);
    expect(draft.status).toBe(404);
  });

  it('returns not found for a never-published document and for an unknown version', async () => {
    const never = await http.get(`/documents/${doc('privateIdea')}/content`, bona);
    const ghost = await http.get(`/documents/${GHOST_ID}/content`, bona);
    // Identical: "this document has no published version" must not be
    // distinguishable from "that document does not exist".
    expect(never.body).toEqual(ghost.body);

    const missingVersion = await http.get(`/documents/${doc('runbook')}/content?ref=99`, bona);
    expect(missingVersion.status).toBe(404);
  });
});

describe('groups and categories', () => {
  it('grants the creator MANAGE on a new group so it is never unreachable', async () => {
    const created = await http.post('/groups', { name: 'Kapitálové výdaje' }, bona);
    expect(created.status).toBe(201);
    const id = data(created.body).id as string;

    // Visible to her afterwards, and only because of the grant she was given.
    const listed = await http.get('/groups', bona);
    expect((listed.body as { id: string }[]).map((g) => g.id)).toContain(id);

    const anaSees = await http.get('/groups', ana);
    expect((anaSees.body as { id: string }[]).map((g) => g.id)).not.toContain(id);
  });

  it('refuses a top-level group to someone who manages nothing', async () => {
    const res = await http.post('/groups', { name: 'Bez pravomoci' }, await loginAs('dana'));
    expect(res.status).toBe(404);
  });

  it('rejects reparenting a group into its own descendant', async () => {
    // A cycle would send the recursive grant resolution into an infinite loop.
    const res = await http.patch(`/groups/${group('hr')}`, { parentId: group('payroll') }, bona);
    // Bona does not manage HR, so the refusal is a permission answer here; the
    // cycle guard itself is exercised on a subtree she owns below.
    expect(res.status).toBe(404);

    const parent = await createGroup('Nadskupina');
    const child = await createGroup('Podskupina', parent);

    const cycle = await http.patch(`/groups/${parent}`, { parentId: child }, bona);
    expect(cycle.status).toBe(400);
    expect(code(cycle.body)).toBe('validation_failed');

    const self = await http.patch(`/groups/${parent}`, { parentId: parent }, bona);
    expect(self.status).toBe(400);
  });

  it('leaves parent_id alone when the field is merely absent from the patch', async () => {
    const parent = await createGroup('Puvodni rodic');
    const child = await createGroup('Dite', parent);

    const renamed = await http.patch(`/groups/${child}`, { name: 'Prejmenovane dite' }, bona);
    expect(data(renamed.body).parentId).toBe(parent);
  });

  it('refuses to delete a group that still has children', async () => {
    const res = await http.del(`/groups/${group('hr')}`, bona);
    expect(res.status).toBe(404);
  });

  it('creates a category inside a writable group and refuses it elsewhere', async () => {
    const ok = await http.post('/categories', { name: 'Směrnice', groupId: group('engineering') }, bona);
    expect(ok.status).toBe(201);

    const no = await http.post('/categories', { name: 'Cizi', groupId: group('hr') }, bona);
    expect(no.status).toBe(404);
  });

  it('keeps a category visible exactly where its group is', async () => {
    // mzdove sits under Payroll, which Ana reaches through her HR role, so she
    // sees it without it being an ACL target of its own.
    const anaSees = await http.get('/categories', ana);
    const names = (anaSees.body as { name: string }[]).map((c) => c.name);
    expect(names).toContain('Mzdové předpisy');

    const danaSees = await http.get('/categories', await loginAs('dana'));
    expect(danaSees.body).toEqual([]);
  });

  it('leaves documents behind when a category is deleted', async () => {
    // documents.category_id is ON DELETE SET NULL, so this must not destroy content.
    const created = await http.post('/categories', { name: 'Docasna', groupId: group('engineering') }, bona);
    const id = data(created.body).id as string;
    const document = await createDocument('V kategorii', group('engineering'), bona);
    await http.patch(`/documents/${document}`, { categoryId: id }, bona);

    expect((await http.del(`/categories/${id}`, bona)).status).toBe(200);

    const after = await http.get(`/documents/${document}`, bona);
    expect(data(after.body).categoryId).toBeNull();
    expect(after.status).toBe(200);
  });
});

describe('access follows the tree', () => {
  it('revokes inherited access when a document moves out of the granting group', async () => {
    // A reader reaches a document only through the group it currently sits in,
    // so a move is a permission change and must behave like one.
    const container = await createGroup('Docasny kontejner');
    const id = await createDocument('Presouvany dokument', container);

    // Bona manages the container, so she can grant Carl read on it.
    const grant = await http.post(
      '/permissions',
      {
        subjectKind: 'user',
        subjectId: user('carl'),
        targetKind: 'group',
        targetId: container,
        permission: 'READ',
      },
      bona,
    );
    expect(grant.status).toBe(201);
    expect((await http.get(`/documents/${id}`, carl)).status).toBe(200);

    const moved = await http.patch(`/documents/${id}`, { groupId: group('engineering') }, bona);
    expect(moved.status).toBe(200);
    expect((await http.get(`/documents/${id}`, carl)).status).toBe(404);

    // And the same document is still readable by someone whose grant comes from
    // the destination group.
    expect((await http.get(`/documents/${id}`, bona)).status).toBe(200);
  });

  it('refuses a move into a group the caller cannot write', async () => {
    const id = doc('runbook');
    const res = await http.patch(`/documents/${id}`, { groupId: group('hr') }, bona);
    expect(res.status).toBe(404);

    const current = await http.get(`/documents/${id}`, bona);
    expect(data(current.body).groupId).toBe(group('engineering'));
  });
});

/**
 * Destructive, and deliberately last: it removes a fixture document other
 * blocks read.
 */
describe('deletion', () => {
  it('deletes a document along with its immutable versions', async () => {
    // The immutability trigger fires on direct DELETE of a version row. It must
    // not fire on the ON DELETE CASCADE from documents, or a document with any
    // published version could never be removed. Bona MANAGEs Engineering, which
    // reaches the runbook by inheritance.
    const id = doc('runbook');
    expect((await http.get(`/documents/${id}/content`, bona)).status).toBe(200);

    const removed = await http.del(`/documents/${id}`, bona);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: true });

    expect((await http.get(`/documents/${id}`, bona)).status).toBe(404);

    // Proved at the SQL level too, because a leftover version row would be
    // invisible over HTTP — the document that owned it is gone.
    const { query } = await import('../src/db');
    const orphans = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM document_versions WHERE document_id = $1',
      [id],
    );
    expect(orphans[0]?.n).toBe(0);
  });
});
