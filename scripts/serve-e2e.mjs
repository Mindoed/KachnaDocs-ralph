#!/usr/bin/env node
// Boots the API for Playwright against the TEST database, on a fixed port.
//
// A node launcher rather than an inline `FOO=bar npm start`: npm scripts run
// under cmd.exe on Windows, where inline env assignment is a different language
// entirely. This is the one form that works on both platforms.
//
// It also prepares its own database and insists on a built frontend, so the
// browser suite is independent of what the jest suite happened to do first, and
// a missing build fails here with a sentence instead of as a 404 in a browser.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = process.env.E2E_PORT ?? '3100';
const testDb =
  process.env.TEST_DATABASE_URL ?? 'postgres://kachna:kachna@localhost:5432/kachnadocs_test';

if (!/kachnadocs_test$/.test(testDb)) {
  console.error(`refusing to serve e2e; TEST_DATABASE_URL looks wrong: ${testDb}`);
  process.exit(1);
}
if (!existsSync(resolve(root, 'frontend/dist/index.html'))) {
  console.error('frontend/dist/index.html is missing — run `npm run build -w frontend` first.');
  process.exit(1);
}

function run(args) {
  const r = spawnSync('npm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, TEST_DATABASE_URL: testDb },
  });
  // r.status is null when npm itself could not be spawned, which must fail too —
  // `?? 0` would turn a broken setup into a green run.
  if (r.status !== 0) {
    console.error(`e2e setup failed: npm ${args.join(' ')}`);
    process.exit(1);
  }
}

run(['run', '-w', 'backend', 'migrate:test']);
run(['run', '-w', 'backend', 'seed:test']);

// ts-node's own bin, not `npm run start`: npm on Windows resolves through a
// .cmd, so the real server sits behind a shell wrapper that Playwright's SIGTERM
// would orphan — the leftover process then holds the port for the next run.
const child = spawn(
  process.execPath,
  [resolve(root, 'node_modules/ts-node/dist/bin.js'), '-r', 'tsconfig-paths/register', 'src/main.ts'],
  {
    cwd: resolve(root, 'backend'),
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', TEST_DATABASE_URL: testDb, PORT: port },
  },
);

child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
child.on('error', (err) => {
  console.error(`could not start the API for e2e: ${err.message}`);
  process.exit(1);
});

// Playwright terminates the webServer when the run ends; without this the child
// is orphaned and the next run dies with EADDRINUSE on a port it owns.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill('SIGTERM'));
}
