#!/usr/bin/env node
// Programmatic node-pg-migrate so the connection string comes from the same
// place as the app: --env=test selects TEST_DATABASE_URL, which keeps the test
// suite from ever migrating the dev database by accident.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import migrate from 'node-pg-migrate';

for (const dir of [process.cwd(), resolve(import.meta.dirname, '../../..')]) {
  const p = resolve(dir, '.env');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m?.[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

const direction = process.argv[2] ?? 'up';
// --env=test as a flag rather than an env var keeps the npm script portable
// (no cross-env dependency, no cmd.exe quoting differences).
const isTest = process.argv.includes('--env=test');
const connectionString = isTest
  ? (process.env.TEST_DATABASE_URL ?? 'postgres://kachna:kachna@localhost:5432/kachnadocs_test')
  : (process.env.DATABASE_URL ?? 'postgres://kachna:kachna@localhost:5432/kachnadocs');

await migrate({
  direction,
  migrationsTable: 'pgmigrations',
  dir: resolve(import.meta.dirname, '../migrations'),
  databaseUrl: connectionString,
  count: 200,
  log: () => undefined,
});

console.log(`✓ migrations ${direction} (${isTest ? 'test' : 'dev'} db)`);
