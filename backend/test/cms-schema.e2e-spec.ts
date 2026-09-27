import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { query } from '../src/db';
import { FIXTURES } from '../src/seed';
import { doc, group, resetDatabase, startServer, stopServer, user } from './helpers';

/**
 * Database-level invariants the rest of phase 2 rests on, each of which was
 * broken at some point during its own making:
 *
 *  1. published versions are immutable to a direct write, yet deletable when
 *     their document is deleted (the trigger originally blocked both)
 *  2. a draft and a published version genuinely differ, so "readers see the
 *     published text" is a testable claim rather than a tautology
 *  3. a document may exist with no version history at all
 *  4. groups cannot be made cyclic, because the ACL resolver would recurse
 *     forever and every read path in the app would hang
 *
 * These assert SQL directly rather than going through HTTP: a trigger is not
 * reachable over the API once a controller stops trying to violate it, and
 * phase 2's controllers arrived *after* these tests, which is the order that
 * keeps a later controller from quietly weakening the schema.
 */
beforeAll(async () => {
  await startServer();
  await resetDatabase();
});

// stopServer() closes the pool itself; closing it here too would end it twice.
afterAll(async () => {
  await stopServer();
});

describe('CMS schema', () => {
  it('rejects any update to a published version', async () => {
    const rows = await query<{ id: string }>('SELECT id FROM document_versions WHERE number = 1 LIMIT 1');
    const version = rows[0];
    expect(version).toBeDefined();

    await expect(
      query('UPDATE document_versions SET title = $1 WHERE id = $2', ['x', version?.id]),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects deleting a published version', async () => {
    // Cascade deletes from documents must stay possible, so this asserts the
    // trigger guards direct deletes rather than the table being undeletable.
    const rows = await query<{ id: string }>('SELECT id FROM document_versions WHERE number = 1 LIMIT 1');
    await expect(query('DELETE FROM document_versions WHERE id = $1', [rows[0]?.id])).rejects.toThrow(
      /immutable/,
    );
  });

  it('keeps exactly one version row per number per document', async () => {
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT document_id, number FROM document_versions GROUP BY 1, 2 HAVING count(*) > 1
       ) dupes`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('stores a draft whose text differs from the published version', async () => {
    // Without this divergence, a "reader sees published, not draft" assertion
    // would pass for the wrong reason.
    const rows = await query<{ draft_markdown: string; published_markdown: string }>(
      `SELECT d.draft_markdown, v.markdown AS published_markdown
         FROM documents d JOIN document_versions v ON v.document_id = d.id
        WHERE d.id = $1 AND v.number = 1`,
      [doc('handbook')],
    );
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.draft_markdown).not.toBe(row?.published_markdown);
    expect(row?.draft_markdown).toContain('Koncept');
    expect(row?.published_markdown).not.toContain('Koncept');
  });

  it('has no version rows for a never-published document', async () => {
    const rows = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM document_versions WHERE document_id = $1',
      [doc('privateIdea')],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('records heading anchors on the published snapshot', async () => {
    const rows = await query<{ anchor: string; level: number; text: string }>(
      `SELECT h.anchor, h.level, h.text
         FROM headings h JOIN document_versions v ON v.id = h.version_id
        WHERE v.document_id = $1`,
      [doc('handbook')],
    );
    expect(rows).toEqual([{ anchor: 'sec-1', level: 1, text: 'Obsah' }]);
  });

  it('reaches the seeded category through its group', async () => {
    // Categories inherit visibility from their group rather than being an ACL
    // target of their own (see migration 1740000005000_cms).
    const rows = await query<{ group_id: string; name: string }>(
      'SELECT group_id, name FROM categories WHERE id = $1',
      [FIXTURES.categories.mzdove],
    );
    expect(rows[0]?.group_id).toBe(FIXTURES.groups.payroll);
  });

  it('still answers for documents that belong to no category', async () => {
    const rows = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM documents WHERE category_id IS NULL',
    );
    expect(rows[0]?.n).toBe(3);
  });

  it('lets a document take its versions with it', async () => {
    // The asymmetry the trigger must get right: a direct version DELETE is
    // refused (asserted above), while the ON DELETE CASCADE from documents must
    // be allowed, or nothing that was ever published could be deleted.
    const id = doc('salaries');
    const before = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM document_versions WHERE document_id = $1',
      [id],
    );
    expect(before[0]?.n).toBe(1);

    await query('DELETE FROM documents WHERE id = $1', [id]);

    const after = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM document_versions WHERE document_id = $1',
      [id],
    );
    expect(after[0]?.n).toBe(0);
  });
});

/**
 * A group cycle is a denial of service rather than untidy data:
 * group_grants_for recurses over parent_id with UNION ALL and no guard of its
 * own, so once a cycle exists every accessible_* / can_access_* call recurses
 * forever. Verified the hard way — the experiment needed a statement_timeout to
 * return at all. Migration 1740000007000 rejects it at the write.
 */
describe('group cycle guard', () => {
  it('rejects reparenting a group under its own descendant', async () => {
    await expect(
      query('UPDATE groups SET parent_id = $1 WHERE id = $2', [group('payroll'), group('hr')]),
    ).rejects.toThrow(/cycle/);
  });

  it('rejects a group as its own parent', async () => {
    await expect(query('UPDATE groups SET parent_id = $1 WHERE id = $1', [group('hr')])).rejects.toThrow(
      /own parent/,
    );
  });

  it('still allows a legitimate reparent', async () => {
    const [created] = await query<{ id: string }>(
      `INSERT INTO groups (parent_id, name) VALUES ($1, 'Presun pred cyklem') RETURNING id`,
      [group('hr')],
    );
    expect(created).toBeDefined();

    // Asserted by re-reading rather than by row count: an UPDATE without
    // RETURNING yields no rows even when it succeeds, so toHaveLength(1) here
    // would fail on a write that worked.
    await query('UPDATE groups SET parent_id = $1 WHERE id = $2', [group('engineering'), created?.id]);
    const moved = await query<{ parent_id: string }>('SELECT parent_id FROM groups WHERE id = $1', [
      created?.id,
    ]);
    expect(moved[0]?.parent_id).toBe(group('engineering'));

    // Clearing the parent is a move to top level, not a cycle.
    await query('UPDATE groups SET parent_id = NULL WHERE id = $1', [created?.id]);
    const cleared = await query<{ parent_id: string | null }>('SELECT parent_id FROM groups WHERE id = $1', [
      created?.id,
    ]);
    expect(cleared[0]?.parent_id).toBeNull();

    await query('DELETE FROM groups WHERE id = $1', [created?.id]);
  });

  it('leaves the ACL resolver responsive afterwards', async () => {
    // The point of the trigger: this query is what hangs when a cycle exists.
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM accessible_groups($1, 'READ') AS ag(grp)`,
      [user('ana')],
    );
    // HR and Payroll, reached through her HR role.
    expect(rows[0]?.n).toBe(2);
  });
});
