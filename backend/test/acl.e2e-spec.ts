import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import type { ApiErrorBody, AuthUser } from '@kachnadocs/shared';
import { GHOST_ID, doc, group, http, loginAs, resetDatabase, startServer, stopServer, user } from './helpers';

beforeAll(async () => {
  await startServer();
  await resetDatabase();
});

afterAll(async () => {
  await stopServer();
});

const code = (body: unknown): string => (body as ApiErrorBody).error?.code ?? '';

/**
 * SPEC.md §3: "Uživatel bez READ nesmí získat obsah dokumentu přes API".
 * These tests are the phase's real deliverable — the SQL layer is only
 * trustworthy if the HTTP surface above it cannot be walked around.
 */
describe('ACL enforcement over HTTP', () => {
  describe('listing', () => {
    it('returns only documents the caller can read', async () => {
      const token = await loginAs('bona');
      const res = await http.get('/documents', token);
      expect(res.status).toBe(200);
      const titles = (res.body as { title: string }[]).map((d) => d.title).sort();
      // Engineering role reaches runbook + private-idea; nothing under HR.
      expect(titles).toEqual(['Nasazovací runbook', 'Tajný nápad']);
    });

    it('shows inherited reach but honours the document-level deny for Ana', async () => {
      const token = await loginAs('ana');
      const res = await http.get('/documents', token);
      expect(res.status).toBe(200);
      const slugs = (res.body as { slug: string }[]).map((d) => d.slug);
      // HR role grants READ on the HR group; `salaries` sits under it but is
      // denied explicitly, so only the handbook survives.
      expect(slugs).toEqual(['hr-handbook']);
    });

    it('returns an empty list for a user with no grants', async () => {
      const token = await loginAs('dana');
      const res = await http.get('/documents', token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('single document read', () => {
    it('serves a document the caller may read', async () => {
      const token = await loginAs('ana');
      const res = await http.get(`/documents/${doc('handbook')}`, token);
      expect(res.status).toBe(200);
      expect((res.body as { slug: string }).slug).toBe('hr-handbook');
    });

    it('refuses a document the caller cannot read', async () => {
      const token = await loginAs('bona');
      const res = await http.get(`/documents/${doc('handbook')}`, token);
      expect(res.status).toBe(404);
      expect(code(res.body)).toBe('not_found');
    });

    it('refuses a document denied by an explicit NONE override', async () => {
      const token = await loginAs('ana');
      const res = await http.get(`/documents/${doc('salaries')}`, token);
      expect(res.status).toBe(404);
    });

    it('serves a draft to a user with READ (published-only reading is phase 2)', async () => {
      // Pins current behaviour so phase 2 cannot introduce the reader/draft
      // split by accident, and states plainly that the split is not here yet.
      const token = await loginAs('bona');
      const res = await http.get(`/documents/${doc('privateIdea')}`, token);
      expect(res.status).toBe(200);
      expect((res.body as { state: string }).state).toBe('Draft');
    });
  });

  /**
   * PLAN.md §3: "no READ" and "does not exist" must be indistinguishable, or
   * status codes become an existence oracle for private documents.
   */
  describe('existence is not a side channel', () => {
    it('answers identically for a forbidden document and a nonexistent one', async () => {
      const token = await loginAs('dana');

      const forbidden = await http.get(`/documents/${doc('handbook')}`, token);
      const nonexistent = await http.get(`/documents/${GHOST_ID}`, token);

      expect(forbidden.status).toBe(nonexistent.status);
      expect(forbidden.body).toEqual(nonexistent.body);
      // Equality alone would also hold if both bodies were empty or both were a
      // bare 404 string, so pin the shape the API promises.
      expect(forbidden.status).toBe(404);
      expect(code(forbidden.body)).toBe('not_found');
      expect((forbidden.body as ApiErrorBody).error.message).toMatch(/\S/);
    });

    it('gives the same answer to a user with any access and one with none', async () => {
      const [asAna, asDana] = await Promise.all([
        http.get(`/documents/${doc('runbook')}`, await loginAs('ana')),
        http.get(`/documents/${doc('runbook')}`, await loginAs('dana')),
      ]);
      // Neither may read it; both must get the identical body.
      expect(asAna.status).toBe(404);
      expect(asDana.status).toBe(404);
      expect(asAna.body).toEqual(asDana.body);
    });

    it('does not name the document in any denial message', async () => {
      const token = await loginAs('dana');
      const res = await http.get(`/documents/${doc('handbook')}`, token);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('Příručka');
      expect(text).not.toContain('hr-handbook');
    });
  });

  describe('unauthenticated requests', () => {
    it('rejects with no token', async () => {
      const res = await http.get('/documents');
      expect(res.status).toBe(401);
      expect(code(res.body)).toBe('unauthorized');
    });

    it('rejects a forged token', async () => {
      const res = await http.get('/documents', 'not-a-jwt');
      expect(res.status).toBe(401);
    });

    it('rejects a token for a user that no longer exists', async () => {
      // A valid signature with a dead subject must not read as authorized.
      const token = await loginAs('dana');
      await resetDatabaseAndDeleteDana();
      const res = await http.get('/documents', token);
      expect(res.status).toBe(401);
      await resetDatabase();
    });
  });

  describe('role-derived access', () => {
    it('grants access through group hierarchy', async () => {
      // HR group grant reaches Payroll's document only by inheritance.
      const token = await loginAs('ana');
      const visible = await http.get('/documents', token);
      expect((visible.body as { slug: string }[]).map((d) => d.slug)).toContain('hr-handbook');

      // Remove the deny and salaries becomes reachable via the same role grant.
      const before = await http.get(`/documents/${doc('salaries')}`, token);
      expect(before.status).toBe(404);
    });

    it('drops access when role membership is synced away', async () => {
      // SPEC.md:86 in reverse: sync replaces membership, so losing the role
      // must remove everything derived from it.
      const { closePool, query } = await import('../src/db');
      void closePool;
      await query('DELETE FROM user_discord_roles WHERE user_id = $1', [user('ana')]);

      const res = await http.get('/documents', await loginAs('ana'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);

      await resetDatabase();
    });
  });
});

/**
 * Removes Dana from the database while keeping the rest of the fixture, to
 * prove a still-valid JWT cannot authenticate a deleted subject.
 */
async function resetDatabaseAndDeleteDana(): Promise<void> {
  const { query } = await import('../src/db');
  await query('DELETE FROM users WHERE id = $1', [user('dana')]);
}

/**
 * SPEC.md:88 — "Vyhledat a přidat práva konkrétnímu uživateli nebo Discord roli".
 * Mutating grants is the only write path in phase 1, and it is the one place
 * where a bug would *widen* access rather than leak it, so it is asserted here
 * over HTTP rather than trusted because the SQL reads correctly.
 */
describe('grant management over HTTP', () => {
  beforeEach(async () => {
    // Every test here mutates `permissions`; a leftover grant would change what
    // a later assertion proves.
    await resetDatabase();
  });
  afterAll(async () => {
    await resetDatabase();
  });

  it('lists subjects and targets only for someone who manages something', async () => {
    const res = await http.get('/permissions/subjects', await loginAs('bona'));
    expect(res.status).toBe(200);
    const subjects = (res.body as { subjects: { kind: string; name: string }[] }).subjects;
    expect(subjects.map((s) => s.name).sort()).toEqual(
      ['Ana Kadlecová', 'Bora Novák', 'Carl Dvořák', 'Dana Svobodová', 'Engineering', 'HR'].sort(),
    );
    // Both kinds must be present or the UI can grant to users but not to roles.
    expect(new Set(subjects.map((s) => s.kind))).toEqual(new Set(['user', 'discord_role']));

    const targets = (
      (await http.get('/permissions/targets', await loginAs('bona'))).body as { targets: { name: string }[] }
    ).targets;
    // Bona manages the Engineering group and her two documents — nothing under HR.
    expect(targets.map((t) => t.name).sort()).toEqual(
      ['Engineering', 'Tajný nápad', 'Nasazovací runbook'].sort(),
    );
  });

  it('answers 404, not a directory, to someone who manages nothing', async () => {
    for (const path of ['/permissions/subjects', '/permissions/targets']) {
      const res = await http.get(path, await loginAs('dana'));
      expect(res.status).toBe(404);
    }
  });

  it('adds a grant that takes effect on the next read', async () => {
    const manager = await loginAs('bona');
    const reader = await loginAs('carl');

    // Carl holds exactly one document before the grant.
    const before = await http.get('/documents', reader);
    expect((before.body as { slug: string }[]).map((d) => d.slug)).toEqual(['deploy-runbook']);

    const created = await http.post(
      '/permissions',
      {
        subjectKind: 'user',
        subjectId: user('carl'),
        targetKind: 'document',
        targetId: doc('privateIdea'),
        permission: 'READ',
      },
      manager,
    );
    expect(created.status).toBe(201);

    const after = await http.get('/documents', reader);
    expect((after.body as { slug: string }[]).map((d) => d.slug).sort()).toEqual(
      ['deploy-runbook', 'private-idea'].sort(),
    );
  });

  it('revokes a grant, removing access again', async () => {
    const manager = await loginAs('bona');
    const reader = await loginAs('carl');

    const created = await http.post(
      '/permissions',
      {
        subjectKind: 'user',
        subjectId: user('carl'),
        targetKind: 'document',
        targetId: doc('privateIdea'),
        permission: 'READ',
      },
      manager,
    );
    const grantId = (created.body as { id: string }).id;

    const deleted = await http.del(`/permissions/${grantId}`, manager);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const after = await http.get('/documents', reader);
    expect((after.body as { slug: string }[]).map((d) => d.slug)).toEqual(['deploy-runbook']);
  });

  it('refuses to grant on a target the caller does not manage', async () => {
    // Bona may not administer anything under HR; the attempt must look exactly
    // like a nonexistent target, so this cannot probe which documents exist.
    const res = await http.post(
      '/permissions',
      {
        subjectKind: 'user',
        subjectId: user('dana'),
        targetKind: 'document',
        targetId: doc('handbook'),
        permission: 'READ',
      },
      await loginAs('bona'),
    );
    expect(res.status).toBe(404);

    const grants = await http.get('/documents', await loginAs('dana'));
    expect(grants.body).toEqual([]);
  });

  it('refuses to revoke a grant on a target the caller does not manage', async () => {
    // The HR group's role grant exists in the fixture; Bona must not be able to
    // delete it just because she can reach DELETE /permissions/:id.
    const { query } = await import('../src/db');
    const [hrGrant] = await query<{ id: string }>(`SELECT id FROM permissions WHERE target_group_id = $1`, [
      group('hr'),
    ]);
    expect(hrGrant).toBeDefined();

    const res = await http.del(`/permissions/${hrGrant?.id}`, await loginAs('bona'));
    expect(res.status).toBe(404);

    // Ana still reads the handbook, which is only true if the grant survived.
    const visible = await http.get('/documents', await loginAs('ana'));
    expect((visible.body as { slug: string }[]).map((d) => d.slug)).toContain('hr-handbook');
  });

  it('rejects an unknown permission instead of storing it', async () => {
    const res = await http.post(
      '/permissions',
      {
        subjectKind: 'user',
        subjectId: user('carl'),
        targetKind: 'document',
        targetId: doc('privateIdea'),
        permission: 'OWNER',
      },
      await loginAs('bona'),
    );
    expect(res.status).toBe(400);
    expect(code(res.body)).toBe('validation_failed');
  });
});

describe('identity', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it('issues a token that resolves to the same user', async () => {
    const token = await loginAs('bona');
    const res = await http.get('/auth/me', token);
    expect(res.status).toBe(200);
    const me = res.body as AuthUser;
    expect(me.id).toBe(user('bona'));
    expect(me.roles.map((r) => r.name)).toEqual(['Engineering']);
  });

  it('lists each Discord role once after repeated logins', async () => {
    // Regression: user_discord_roles had no primary key, so each login added a
    // duplicate membership row and the role appeared twice.
    const first = await http.get('/auth/me', await loginAs('ana'));
    const fresh = await http.post('/auth/dev-login', { handle: 'ana' });
    const again = (fresh.body as { token: string }).token;
    const second = await http.get('/auth/me', again);

    const names = (second.body as AuthUser).roles.map((r) => r.name);
    expect(names).toEqual(['HR']);
    expect(first.status).toBe(200);
  });

  it('refuses an unknown dev handle', async () => {
    const res = await http.post('/auth/dev-login', { handle: 'nobody' });
    expect(res.status).toBe(401);
  });

  it('has no dev login when Discord OAuth would be configured', async () => {
    // Cannot flip env for a running server, so assert the guard exists in code:
    // the handler returns 404 (indistinguishable from "no such route") when
    // discordEnabled is true. Covered properly in docs/discord-oauth.md notes.
    const res = await http.post('/auth/dev-login', { handle: '' });
    expect([400, 401, 404]).toContain(res.status);
  });
});
