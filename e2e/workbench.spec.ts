import { expect, test, type Page } from '@playwright/test';

/**
 * Scope: what only a real browser against the real API can prove — that the
 * built bundle boots, signs in, keeps its session across a reload, and shows the
 * ACL-derived data the API computed. ACL *decisions* are asserted far faster in
 * backend/test/acl.e2e-spec.ts; duplicating them here would only slow the gate.
 *
 * Fixtures come from backend/src/seed.ts (see FIXTURES there), which asserts the
 * same expectations through the SQL ACL functions, so these numbers are checked
 * twice from two directions.
 */

/** Signs in through the dev login form, exactly as a user would. */
async function login(page: Page, handle: string): Promise<void> {
  await page.goto('/');
  await page.fill('input[autocomplete="username"]', handle);
  await page.getByRole('button', { name: /Přihlásit se/ }).click();
  await expect(page.locator('footer.status')).toBeVisible();
}

test('a signed-in session survives a reload', async ({ page }) => {
  await login(page, 'ana');

  await expect(page.locator('footer.status')).toContainText('Ana');
  const token = await page.evaluate(() => localStorage.getItem('kachnadocs.token'));
  expect(token, 'login must persist a token').toBeTruthy();

  // Reload is the interesting transition: App.vue's restore() must turn the
  // stored token back into a user, or a refresh logs everyone out.
  await page.reload();
  await expect(page.locator('footer.status')).toContainText('Ana');
});

test('effective permissions are rendered with their source', async ({ page }) => {
  await login(page, 'ana');

  // Ana is granted nothing directly: everything she has arrives through the HR
  // Discord role. The three rows are the interesting shapes at once — a document
  // via a role, a group via a role, and a group inherited from that group
  // (Payroll is a child of HR). SPEC.md:84 asks for "zděděno z HR" vs
  // "přiděleno přímo", so the source text is the assertion, not the grant.
  const grants = page.locator('.permissions .grants > li');
  await expect(grants).toHaveCount(3);

  const handbook = grants.filter({ hasText: 'Příručka HR' });
  await expect(handbook).toContainText('READ');
  await expect(handbook).toContainText('dokument');
  await expect(handbook).toContainText('z role HR');

  // Inheritance has to be distinguishable from a direct role grant, or the
  // hierarchy is invisible in the UI and the API's extra source kind is wasted.
  const payroll = grants.filter({ hasText: 'Payroll' });
  await expect(payroll).toContainText('skupina');
  await expect(payroll).toContainText('zděděno z role — HR přes HR');
});

test('a user with no grants sees an empty list, not an error', async ({ page }) => {
  await login(page, 'dana');

  // Dana is the default-deny fixture. Asserting the empty state here keeps
  // "no permissions" distinct from "the request failed" in the UI, which is the
  // same distinction the API makes by returning 200 with [] rather than 404.
  await expect(page.locator('.permissions .empty')).toContainText('nemá žádná oprávnění');
  await expect(page.locator('.permissions .error')).toHaveCount(0);
});

test('an unknown dev identity is refused without leaving a session behind', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[autocomplete="username"]', 'nobody');
  await page.getByRole('button', { name: /Přihlásit se/ }).click();

  await expect(page.locator('.error')).toBeVisible();
  // A failed login that still wrote a token would leave the app half-signed-in
  // and every later request carrying junk.
  expect(await page.evaluate(() => localStorage.getItem('kachnadocs.token'))).toBeNull();
});

test('layout choices persist, and the API serves the shell at any route', async ({ page }) => {
  await login(page, 'bona');

  // The right sidebar holds the permissions view; hiding it must remove its
  // column entirely (Workbench uses flex for this reason) and stick across a
  // reload, since a docking store that forgets is the bug this store exists to avoid.
  await page.locator('.dock.right .close').click();
  await expect(page.locator('.dock.right')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.dock.right')).toHaveCount(0);

  // The button's accessible name is its glyph, so address it by title.
  await page.getByTitle('Obnovit rozložení').click();
  await expect(page.locator('.dock.right')).toHaveCount(1);
});

test('the API serves the app shell for a deep link', async ({ page }) => {
  // There is no router yet, but phase 2 needs /documents/:slug#anchor to load
  // the SPA rather than 404, and the backend owns that fallback once it serves
  // the bundle. Asserting it now keeps the fallback from being discovered
  // missing while debugging something else.
  await page.goto('/documents/some-slug');
  await expect(page.locator('.login')).toBeVisible();
  await expect(page).toHaveTitle(/KachnaDocs/);
});

test('a manager can grant and revoke, and the effective list follows', async ({ page }) => {
  // Bona MANAGEs the Engineering group and her two documents; Carl holds only the
  // runbook. Granting Carl READ on "Tajný nápad" is the smallest real change that
  // exercises POST + DELETE + the effective-permissions refresh in one pass.
  await login(page, 'bona');

  const editor = page.locator('.editor');
  await expect(editor).toBeVisible();
  // Everything grantable on targets Bona MANAGEs: the Engineering group's two
  // role grants (READ, WRITE) plus her two direct document grants.
  await expect(editor.locator('.explicit li')).toHaveCount(4);

  await editor.locator('input[placeholder^="jméno"]').fill('Carl');
  await expect(editor.locator('select').first().locator('option', { hasText: 'Carl Dvořák' })).toBeAttached();
  await editor.locator('select').first().selectOption({ label: 'Carl Dvořák (uživatel)' });

  await editor.locator('input[placeholder^="název"]').fill('Tajný');
  await editor.locator('select').nth(1).selectOption({ label: 'Tajný nápad (dokument)' });

  await editor.getByRole('button', { name: 'Přidat' }).click();
  await expect(editor.locator('.notice')).toContainText('Uděleno READ');
  await expect(editor.locator('.explicit li')).toHaveCount(5);

  // Revoking must return the database to the state the rest of this file assumes,
  // which is what lets this test run against the shared seeded fixture at all.
  const carlRow = editor.locator('.explicit li').filter({ hasText: 'Carl Dvořák' }).filter({
    hasText: 'Tajný nápad',
  });
  await expect(carlRow).toHaveCount(1);
  await carlRow.getByTitle('Zrušit grant').click();
  await expect(editor.locator('.explicit li')).toHaveCount(4);
  await expect(carlRow).toHaveCount(0);
});

test('the grant editor is absent for someone who manages nothing', async ({ page }) => {
  // Dana has no grants at all, so /permissions/subjects answers 404 and the form
  // hides itself. Asserting absence here is the guard against a UI that shows an
  // editor and relies on the POST failing — hiding is presentation, not control,
  // but a form that cannot work should not be offered.
  await login(page, 'dana');
  await expect(page.locator('.editor')).toHaveCount(0);
  await expect(page.locator('.permissions .empty')).toContainText('nemá žádná oprávnění');
});

test('/api/docs serves the OpenAPI document', async ({ request }) => {
  const res = await request.get('/api/docs-json');
  expect(res.ok()).toBeTruthy();
  const spec = (await res.json()) as { paths: Record<string, unknown> };
  // Paths are listed with the global prefix, which is the part a hand-written
  // spec gets wrong and SwaggerModule cannot.
  for (const path of ['/api/health', '/api/auth/me', '/api/permissions/effective']) {
    expect(spec.paths, `missing ${path} from the OpenAPI document`).toHaveProperty(path);
  }
});
