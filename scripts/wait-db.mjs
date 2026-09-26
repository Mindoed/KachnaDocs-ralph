#!/usr/bin/env node
// Waits until Postgres in docker accepts connections, then ensures the test
// database exists. Used by `npm run verify` before lint/test so the gate never
// fails just because the container was still booting.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

// Minimal .env reader (avoid pulling dotenv into tooling scripts).
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const testUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://kachna:kachna@localhost:5432/kachnadocs_test';
const dbName = new URL(testUrl).pathname.slice(1);

const ready = () => {
  try {
    execFileSync('docker', ['exec', 'kachnadocs-db', 'pg_isready', '-q', '-U', 'kachna'], {
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
};

const deadline = Date.now() + 120_000;
while (!ready()) {
  if (Date.now() > deadline) {
    console.error('✗ Postgres did not become ready within 120s (is Docker Desktop running?)');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

// CREATE DATABASE has no IF NOT EXISTS; tolerate the "already exists" error.
try {
  execFileSync(
    'docker',
    [
      'exec',
      'kachnadocs-db',
      'psql',
      '-U',
      'kachna',
      '-d',
      'postgres',
      '-c',
      `CREATE DATABASE ${dbName}`,
    ],
    { stdio: 'pipe' },
  );
  console.log(`✓ created database ${dbName}`);
} catch {
  console.log(`✓ database ${dbName} already present`);
}
console.log('✓ Postgres ready');
