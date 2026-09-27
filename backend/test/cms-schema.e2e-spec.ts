import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { query } from '../src/db';
import { FIXTURES } from '../src/seed';
import { doc, resetDatabase, startServer, stopServer } from './helpers';

/**
 * The phase-2 schema carries three properties that the rest of the phase will
 * rely on and that nothing else would catch if they regressed:
 *
 *  1. published versions are immutable at the *database* level
 *  2. a draft and a published version genuinely differ, so "readers see the
 *     published text" is a testable claim rather than a tautology
 *  3. a document may exist with no version history at all
 *
 * The assertions run over SQL directly because there are no CMS endpoints yet —
 * that is the next iteration. Asserting the schema now means a later controller
 * cannot quietly weaken it and stay green. The server is still booted, for two
 * reasons: startServer() migrates the test database, and it is what proves this
 * file's queries run against the same schema the API does rather than whatever
 * happened to be left in the container.
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
});
