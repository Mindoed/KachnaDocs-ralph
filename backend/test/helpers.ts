import { execFileSync } from 'node:child_process';
import type { INestApplication } from '@nestjs/common';
import type { AppEnv } from '../src/env';
import { closePool, reconfigure } from '../src/db';
import { FIXTURES, seed } from '../src/seed';
import { createApp } from '../src/bootstrap';

/**
 * The suite talks to the API over real HTTP, not through supertest's in-process
 * app, for two reasons: it exercises the middleware/guard chain exactly as a
 * client sees it (including the global prefix and CORS), and it fails when the
 * server cannot boot at all — which is precisely the class of bug (missing
 * primary key, wrong-arity SQL call) that typechecking did not catch.
 *
 * One server for the whole run; tests are sequential so the shared seeded
 * database cannot be mutated under a running assertion.
 */
let app: INestApplication | null = null;
let env: AppEnv | null = null;
let origin = '';

export function apiOrigin(): string {
  if (!origin) throw new Error('startServer() has not run');
  return origin;
}

export async function startServer(): Promise<void> {
  // Fail loudly rather than silently testing against the dev database.
  if (!/kachnadocs_test$/.test(process.env.TEST_DATABASE_URL ?? '')) {
    throw new Error(
      `refusing to run e2e tests; TEST_DATABASE_URL looks wrong: ${process.env.TEST_DATABASE_URL}`,
    );
  }

  // Migrate the test database so a fresh container or a new migration cannot
  // produce a green run against a stale schema.
  execFileSync(process.execPath, ['scripts/migrate.mjs', 'up', '--env=test'], {
    cwd: process.cwd(),
    stdio: 'pipe',
  });

  reconfigure({ databaseUrl: process.env.TEST_DATABASE_URL });
  ({ app, env } = await createApp());
  // Port 0 lets the OS choose, so a developer running the API on 3000 does not
  // block the suite.
  await app.listen(0);
  const url = app.getHttpServer().address();
  if (typeof url === 'string' || url === null) throw new Error('could not determine listening address');
  origin = `http://127.0.0.1:${url.port}`;
}

export async function stopServer(): Promise<void> {
  await app?.close();
  // The pg pool keeps sockets open, which makes Jest hang after a green run
  // and eventually fail the gate on a timeout it did not earn.
  await closePool();
  tokenCache.clear();
  app = null;
  env = null;
  origin = '';
}

export function appEnv(): AppEnv {
  if (!env) throw new Error('startServer() has not run');
  return env;
}

export async function resetDatabase(): Promise<void> {
  await seed();
}

export interface Res {
  status: number;
  body: unknown;
}

async function call(method: string, path: string, token?: string, payload?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (payload !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${apiOrigin()}/api${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // Non-JSON response body stays a string so assertions can inspect it.
  }
  return { status: res.status, body };
}

export const http = {
  get: (path: string, token?: string) => call('GET', path, token),
  post: (path: string, payload?: unknown, token?: string) => call('POST', path, token, payload),
  patch: (path: string, payload?: unknown, token?: string) => call('PATCH', path, token, payload),
  put: (path: string, payload?: unknown, token?: string) => call('PUT', path, token, payload),
  del: (path: string, token?: string) => call('DELETE', path, token),
};

export type FixtureUser = keyof typeof FIXTURES.users;

const tokenCache = new Map<string, string>();

/** Sign in as a seeded dev identity and remember the token. */
export async function loginAs(user: FixtureUser): Promise<string> {
  const cached = tokenCache.get(user);
  if (cached) return cached;
  const res = await http.post('/auth/dev-login', { handle: user });
  if (res.status !== 201)
    throw new Error(`login as ${user} failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = (res.body as { token: string }).token;
  tokenCache.set(user, token);
  return token;
}

export function doc(name: keyof typeof FIXTURES.documents): string {
  return FIXTURES.documents[name];
}

export function group(name: keyof typeof FIXTURES.groups): string {
  return FIXTURES.groups[name];
}

export function user(name: FixtureUser): string {
  return FIXTURES.users[name];
}

/** A UUID that exists in no table, for "does not exist" assertions. */
export const GHOST_ID = '00000000-dead-beef-0000-000000000000';
