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
