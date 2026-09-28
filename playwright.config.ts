import { defineConfig, devices } from '@playwright/test';

const port = process.env.E2E_PORT ?? '3100';
const baseURL = `http://127.0.0.1:${port}`;

/**
 * Playwright's scope is deliberately narrow (PLAN §4): it owns the paths a unit
 * test cannot reach — a real browser, the built bundle, real navigation, and the
 * realtime collaboration paths arriving in phase 3. It is not the place for ACL
 * assertions, which the jest HTTP suite covers far faster against the same code.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  /**
   * One worker, because the suites share one seeded database and mutate it.
   *
   * `fullyParallel: false` only stops tests *within* a file from overlapping: two
   * files still land on two workers, both pointed at the single server `webServer`
   * starts and the single test database it seeds. That was invisible until
   * `realtime.spec.ts` arrived, because phase 2's suite only reads. The realtime
   * suite types into documents and publishes them, and each file asserted on facts
   * the other was busy changing — the presence list showed 4 collaborators when
   * phase 2's editor had joined the same room, and the seeded runbook's diff showed
   * 4 lines where phase 2 expects its pristine 3. Both directions, intermittently,
   * depending on which worker got there first.
   *
   * Serialising the files is the honest fix; narrowing or waiting on those
   * assertions would have been a test that no longer checks anything. The alternative
   * — a second server on a second database — buys a few seconds of wall clock and
   * costs a second compose service, a second migrate+seed per run, and two databases
   * that can drift; the whole suite runs in about a minute.
   */
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Serves the API *and* frontend/dist on one origin, and migrates + seeds the
    // test database itself, so this does not depend on jest having run first.
    command: 'node scripts/serve-e2e.mjs',
    url: `${baseURL}/api/health`,
    // ts-node compiles the whole backend on boot; 10s is optimistic on a cold
    // Windows filesystem cache and a timeout here reads as an app bug.
    timeout: 90_000,
    reuseExistingServer: false,
  },
});
