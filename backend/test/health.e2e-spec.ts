import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { http, startServer, stopServer } from './helpers';

/**
 * Kept in its own file rather than folded into the ACL suite: this asserts the
 * deployment contract (unauthenticated, 200, real DB probe), not access control.
 */
describe('GET /api/health (e2e)', () => {
  beforeAll(async () => {
    await startServer();
  });
  afterAll(stopServer);

  it('is reachable without a token and reports a live database and pgvector', async () => {
    const res = await http.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
    // Non-null here is the pgvector assertion: the image the phase-5 embeddings
    // need is the same one running these tests, and this is where we find out
    // otherwise.
    expect((res.body as { pgvector: string | null }).pgvector).toBeTruthy();
  });
});
