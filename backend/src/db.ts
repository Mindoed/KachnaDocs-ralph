import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { readEnv, type AppEnv } from './env';

export let env: AppEnv = readEnv();
let pool = new Pool({ connectionString: env.databaseUrl, max: 10 });

/** Re-point the pool at another database (used by tests). */
export function reconfigure(next: Partial<Record<keyof AppEnv, unknown>> & { databaseUrl?: string }): void {
  if (next.databaseUrl && next.databaseUrl !== env.databaseUrl) {
    void pool.end().catch(() => undefined);
    env = { ...env, databaseUrl: next.databaseUrl };
    pool = new Pool({ connectionString: next.databaseUrl, max: 10 });
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as unknown[]);
  return res.rows;
}

export async function withTransaction<R>(fn: (client: PoolClient) => Promise<R>): Promise<R> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
