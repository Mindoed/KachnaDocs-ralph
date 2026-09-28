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

test('the CMS tree lists the caller’s documents and selecting one shows its history', async ({ page }) => {
  // One browser context on purpose. Two-context sync is phase 3's job (PLAN §4
  // scopes Playwright to realtime behavior); what this phase needs proven here
  // is narrower and still cannot be seen any other way: that the built bundle
  // renders the four-level hierarchy and that clicking a tree row drives a
  // second, independently-docked panel off the same store.
  await login(page, 'bona');

  const tree = page.locator('.tree[role="tree"]');
  await expect(tree).toBeVisible();
  // Bona sees the Engineering group and both of her documents, and nothing from
  // HR — the tree is built from API results that are already ACL-filtered.
  await expect(tree.locator('.row.group')).toHaveCount(1);
  await expect(tree.locator('.row.document')).toHaveCount(2);
  await expect(tree.locator('.row.document', { hasText: 'Tajný nápad' })).toBeVisible();
  await expect(tree.locator('.row.document', { hasText: 'Příručka HR' })).toHaveCount(0);

  // State badge per SPEC.md §1 "Zobrazovat stav dokumentu". Czech label, not the
  // stored enum value: the badge renders DOCUMENT_STATE_LABEL from shared/, and
  // asserting the rendered word is what catches a panel that reverts to showing
  // "Published" in a Czech UI.
  const runbook = tree.locator('.row.document', { hasText: 'Nasazovací runbook' });
  await expect(runbook.locator('.badge')).toHaveText('Publikováno');

  await runbook.click();
  const history = page.locator('.dock.right .history');
  await expect(history).toBeVisible();
  // The seed gives every Published document exactly one version.
  await expect(history.locator('.versions li')).toHaveCount(1);
  await expect(history).toContainText('První publikace');
  // Bona MANAGEs it, so publishing is offered to her.
  await expect(history.getByRole('button', { name: /Publikovat koncept/ })).toBeVisible();

  await history.locator('.versions li .num').click();
  await expect(history.locator('.snapshot')).toContainText('Kroky nasazení.');

  // The runbook's seed draft is word-for-word its published text, so the honest
  // expectation is a diff with lines but no additions or deletions — an empty
  // diff list would mean the viewer had nothing to render at all.
  await history.getByRole('button', { name: /Srovnat s aktuální/ }).click();
  await expect(history.locator('.diff li')).toHaveCount(3);
  await expect(history.locator('.diff li.add, .diff li.remove')).toHaveCount(0);
  await expect(history.locator('.summary')).toContainText('+0 / −0');

  // The move affordance (SPEC.md §1 "přesouvat"). Opened and cancelled rather
  // than committed: Bona holds WRITE on exactly one group, so there is no second
  // group to move into, and committing here would mutate the fixture the tests
  // above and below assume. Where a move actually lands is asserted over HTTP in
  // backend/test/cms-crud.e2e-spec.ts, which can create a destination.
  await runbook.getByTitle('Přesunout').click();
  const move = tree.locator('.move');
  await expect(move).toBeVisible();
  // Only groups the caller may write are offered, and one is preselected so the
  // form starts from where the document actually is. Bona writes one group, so
  // the list has one entry — the same writableGroups filter that hides the
  // "new document" form from Carl.
  await expect(move.locator('select').first().locator('option')).toHaveCount(1);
  await expect(move.locator('select').first()).not.toHaveValue('');
  await move.getByRole('button', { name: 'Zrušit' }).click();
  await expect(move).toHaveCount(0);
});

test('a reader is offered no write affordances in the tree', async ({ page }) => {
  // Carl READs the runbook and nothing else. The point is not that he cannot
  // click — the backend would refuse him anyway (PLAN §3.5) — but that the
  // affordances are absent, which is only observable in a browser.
  await login(page, 'carl');
  const tree = page.locator('.tree[role="tree"]');
  await expect(tree.locator('.row.document')).toHaveCount(1);
  await expect(tree.locator('.row .actions')).toHaveCount(0);
  // No writable group, so no "new document" form either.
  await expect(tree.locator('.create')).toHaveCount(0);

  await tree.locator('.row.document').click();
  await expect(page.locator('.dock.right .history').getByRole('button', { name: /Publikovat/ })).toHaveCount(
    0,
  );
});

test('the tree shows all three levels and honors a deny override', async ({ page }) => {
  // SPEC.md §1's first bullet names three levels — skupiny, kategorie, dokumenty —
  // and a tree that rendered only groups and documents would satisfy every
  // assertion above. Ana is the reader who sees the middle level: the one
  // category hangs off Payroll, which she reaches by inheriting from HR.
  await login(page, 'ana');
  const tree = page.locator('.tree[role="tree"]');

  await expect(tree.locator('.row.group')).toHaveCount(2); // HR, Payroll
  await expect(tree.locator('.row.category')).toHaveCount(1);
  await expect(tree.locator('.row.category')).toContainText('Mzdové předpisy');
  // The category nests under its group, so it must be indented deeper.
  expect(
    await tree
      .locator('.row.category')
      .first()
      .evaluate((el) => el.style.getPropertyValue('--depth')),
  ).not.toBe('0');

  // Ana's document-level NONE (SPEC.md:82) denies her the salaries document even
  // though HR inheritance reaches it. This is that override observable in the
  // hierarchy rather than only in an API response.
  await expect(tree.locator('.row.document', { hasText: 'Příručka HR' })).toBeVisible();
  await expect(tree.locator('.row.document', { hasText: 'Ohodnocování' })).toHaveCount(0);

  // And the badge next to the group must agree with what she can see. An earlier
  // version of GET /groups counted documents without the ACL, so Ana's tree read
  // "Payroll 1" above an empty set of Payroll rows: the group was open to her, the
  // document was not, and the number told her it existed. That is PLAN §3.3's leak
  // in one rendered digit, which is why it is checked here in the browser rather
  // than only at the API — the backend guard is `counts agree with the ACL`.
  const payroll = tree.locator('.row.group', { hasText: 'Payroll' });
  await expect(payroll.locator('.count')).toHaveText('0');
});

test('NONE is reachable in the grant editor and renders as a denial', async ({ page }) => {
  // Phase 1 deferred this because the deny override (SPEC.md:82) needed to appear
  // next to the grant it overrides. What a browser can check is the part of that
  // which is genuinely UI: the option is selectable, and once stored it reads as a
  // denial rather than as a fourth rung below READ. That NONE actually denies is
  // asserted over HTTP in acl.e2e-spec.ts, where the SQL resolver decides.
  await login(page, 'bona');

  const editor = page.locator('.editor');
  await editor.locator('input[placeholder^="jméno"]').fill('Carl');
  await editor.locator('select').first().selectOption({ label: 'Carl Dvořák (uživatel)' });
  await editor.locator('input[placeholder^="název"]').fill('Tajný');
  await editor.locator('select').nth(1).selectOption({ label: 'Tajný nápad (dokument)' });

  const permission = editor.locator('select').nth(2);
  await permission.selectOption('NONE');
  // The explanation appears only for NONE, which is the signal that this is not
  // one more permission level.
  await expect(editor.locator('.deny-note')).toBeVisible();

  await editor.getByRole('button', { name: 'Přidat' }).click();
  const noneRow = editor
    .locator('.explicit li')
    .filter({ hasText: 'Tajný nápad' })
    .filter({ hasText: 'NONE' });
  await expect(noneRow).toHaveCount(1);
  await expect(noneRow.locator('.badge')).toHaveCount(1);

  await noneRow.getByTitle('Zrušit grant').click();
  await expect(noneRow).toHaveCount(0);
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
