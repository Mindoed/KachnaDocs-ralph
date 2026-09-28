import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * SPEC.md §2, in a browser, with two of them.
 *
 * ## Why this file cannot be a jest test
 *
 * "Změna provedená jedním uživatelem se bez obnovení stránky zobrazí ostatním" is a
 * claim about a live page that keeps its DOM while somebody else types.
 * `backend/test/realtime.e2e-spec.ts` speaks the wire format directly and asserts the
 * ACL, the persistence and the framing — and it cannot see that Tiptap rendered a
 * remote update into the wrong node, that the anchor extension stamped two ids on one
 * heading, that a NodeView leaked a subscriber, or that the page died on a stale
 * ticket. Those are failures a hand-rolled client is structurally blind to, and they
 * are the failures a real collaborative editor actually ships with.
 *
 * ## Two contexts, and the assumption that must not be allowed to rot
 *
 * Two browser *contexts*, not two tabs, because y-websocket syncs same-origin tabs
 * through `BroadcastChannel` by default — which would let the headline test pass with
 * the gateway switched off. `disableBc: true` in `useRealtime.ts` closes that hole;
 * this paragraph exists so whoever re-enables it finds this sentence first.
 *
 * Fixtures come from `backend/src/seed.ts`. Bona holds WRITE+MANAGE on the deploy
 * runbook; Carl holds a direct READ grant on that one document and nothing else.
 */

const RUNBOOK_TITLE = 'Nasazovací runbook';

/** Signs in through the dev login form, as a user would. */
async function login(page: Page, handle: string): Promise<void> {
  await page.goto('/');
  await page.fill('input[autocomplete="username"]', handle);
  await page.getByRole('button', { name: /Přihlásit se/ }).click();
  await expect(page.locator('footer.status')).toBeVisible();
}

/**
 * Returns to a URL after a reload, *without* signing in again.
 *
 * The session lives in `localStorage`, which survives a reload, so the app renders
 * the workbench directly and there is no username field to fill. Calling `login`
 * after `reload` fails on a missing input — which reads as a broken login form and is
 * actually a test that signed in twice.
 */
async function revisit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('footer.status')).toBeVisible();
}

/** Opens a document in the editor by clicking it in the CMS tree. */
async function openDocument(page: Page, title: string): Promise<void> {
  await page.locator('.tree .row.document', { hasText: title }).first().click();
  await expect(surface(page)).toBeVisible();
}

const surface = (page: Page): Locator => page.locator('[data-testid=editor-host] .tiptap');

/**
 * The editor, settled: synced, and — for a writer — saved.
 *
 * Waiting for the save indicator rather than for the element to exist. An editor
 * mounted against an as-yet-empty Y.Doc looks identical for a moment, and text typed
 * into that moment goes into a fragment the incoming sync then reconciles — so "the
 * box is on screen" is not yet "the box is the document". The indicator is the one
 * thing on screen whose value is computed by the server.
 *
 * Both settled labels are accepted because a reader's never says "Uloženo": it has
 * nothing to save. Matching only the writer's label made every reader-side wait time
 * out on "Režim jen pro čtení", which reads as a connection failure and is a helper
 * that only knows one kind of user.
 */
async function ready(page: Page): Promise<Locator> {
  await expect(page.getByTestId('save-state')).toHaveText(/Uloženo|Režim jen pro čtení/, { timeout: 20_000 });
  return surface(page);
}

async function typeAtEnd(page: Page, text: string): Promise<void> {
  const editor = await ready(page);
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text, { delay: 5 });
}

/**
 * Asks, from inside a page that is already viewing a document: "if I hand this room a
 * well-formed update frame, do I get refused?"
 *
 * Returns the socket's close code, 1000 for "still connected a second later", or a
 * negative sentinel for a probe that never got that far. Three deliberate choices:
 *
 * - The frame is `[sync, update, <empty update>]` — bytes 0, 2, then a two-byte
 *   varuint8array holding `Y.encodeStateAsUpdate(new Y.Doc())`, which Yjs applies as a
 *   no-op. It must be *well-formed*: the gateway refuses a read-only update before it
 *   decodes anything, so a garbage payload would be refused for the wrong reason and
 *   the writer's control arm would only prove "the server gave up on this junk too".
 *   The two arms have to differ in exactly one thing, the permission behind the ticket.
 * - The ticket is minted by the page's own session over the page's own origin, and the
 *   document id is read from the page's own URL (`/d/<id>`), so neither can be the
 *   harness's choice. The document the page is looking at is also the only one both
 *   users are guaranteed to have access to.
 * - "Not refused" has to be an answer. An accepted frame produces no close at all, so a
 *   promise that settles only on close never resolves for a writer; that arrived as a
 *   30-second timeout with "target page, context or browser has been closed", which
 *   reads like a crash and is really a test that forgot what success looks like.
 */
async function refused(page: Page): Promise<number> {
  const probe = page.evaluate(async () => {
    const id = window.location.pathname.split('/').filter(Boolean).pop();
    if (!id) return -1;
    const token = localStorage.getItem('kachnadocs.token');
    const minted = await fetch(`/api/documents/${id}/realtime-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!minted.ok) return -2;
    const { ticket } = (await minted.json()) as { ticket: string };

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${window.location.host}/api/realtime/${id}?ticket=${ticket}`);
    return new Promise<number>((resolve) => {
      const settled = (code: number) => {
        clearTimeout(timer);
        resolve(code);
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      };
      const timer = setTimeout(() => settled(1000), 1000);
      socket.onopen = () => socket.send(new Uint8Array([0, 2, 2, 0, 0]));
      socket.onclose = (event) => settled(event.code);
      socket.onerror = () => settled(-3);
    });
  });
  // Belt and braces: a probe that hangs must fail as an assertion, not as a timeout.
  return Promise.race([probe, new Promise<number>((r) => setTimeout(() => r(-99), 9_000))]);
}

test.describe('collaborative editing, two browsers', () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let bona: Page;
  let other: Page;

  test.beforeEach(async ({ browser }) => {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    bona = await contextA.newPage();
    other = await contextB.newPage();
  });

  test.afterEach(async () => {
    await contextA.close();
    await contextB.close();
  });

  test('what one writer types appears in the other without a reload', async () => {
    await login(bona, 'bona');
    await login(other, 'bona');
    await openDocument(bona, RUNBOOK_TITLE);
    await openDocument(other, RUNBOOK_TITLE);

    const marker = `vet-a-${Date.now()}`;
    await typeAtEnd(bona, marker);

    // The whole point of the phase, on a page that was never reloaded.
    await expect(await ready(other)).toContainText(marker, { timeout: 15_000 });

    // …and back the other way, because a one-directional bridge passes a test that
    // only ever looked one way.
    const reply = `vet-b-${Date.now()}`;
    await typeAtEnd(other, reply);
    await expect(await ready(bona)).toContainText(reply, { timeout: 15_000 });
    await expect(await ready(other)).toContainText(reply, { timeout: 15_000 });
  });

  test('simultaneous edits in different places both survive', async () => {
    await login(bona, 'bona');
    await login(other, 'bona');
    await openDocument(bona, RUNBOOK_TITLE);
    await openDocument(other, RUNBOOK_TITLE);

    // One shared paragraph to start from, then a split: two writers typing in the
    // *same* text block is the case last-writer-wins loses, so it is the one worth
    // constructing deliberately rather than hoping two Caret+Ends happen to land
    // apart.
    const seed = `spolecny-odstavec-${Date.now()}`;
    await typeAtEnd(bona, seed);
    await expect(await ready(other)).toContainText(seed, { timeout: 15_000 });

    for (const [page, letter] of [
      [bona, 'A'],
      [other, 'B'],
    ] as const) {
      const editor = await ready(page);
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type(` poznamka ${letter}`);
    }

    // Both letters, in both browsers, and the shared seed still there. A merge that
    // lost one side would leave exactly one of A/B.
    for (const page of [bona, other]) {
      const editor = await ready(page);
      await expect(editor).toContainText('poznamka A', { timeout: 15_000 });
      await expect(editor).toContainText('poznamka B', { timeout: 15_000 });
      await expect(editor).toContainText(seed);
    }
  });

  test('the presence list names the collaborators on both sides', async () => {
    await login(bona, 'bona');
    await login(other, 'bona');
    await openDocument(bona, RUNBOOK_TITLE);
    await openDocument(other, RUNBOOK_TITLE);

    // Both directions on purpose: "shows the other person" and "shows me too" are
    // different bugs, and a list that renders only yourself looks correct in a
    // single-browser test forever.
    const chips = bona.getByTestId('presence').locator('.chip');
    await expect(chips).toHaveCount(2, { timeout: 15_000 });
    await expect(other.getByTestId('presence').locator('.chip')).toHaveCount(2, { timeout: 15_000 });
  });

  test('a READ-only user is refused by the server, not by the toolbar', async () => {
    await login(bona, 'bona');
    await login(other, 'carl');
    await openDocument(bona, RUNBOOK_TITLE);
    await openDocument(other, RUNBOOK_TITLE);

    // The affordance, asserted because SPEC.md §2 asks for READ to be respected in
    // the UI too — but never asserted as the reason anything is safe.
    await expect(other.getByTestId('toolbar')).toHaveCount(0);
    await expect(bona.getByTestId('toolbar')).toBeVisible();
    await expect(other.getByTestId('save-state')).toHaveText('Režim jen pro čtení');
    await expect(other.locator('[data-testid=editor-host] .tiptap')).toHaveAttribute(
      'contenteditable',
      'false',
    );

    // A reader is shown the published text and not the draft. The seeded runbook has
    // identical draft and published text, so a *writer* has to create the difference
    // first — which is also the realistic case: someone else is mid-edit.
    const unsaved = `rozpracovano-${Date.now()}`;
    await typeAtEnd(bona, unsaved);
    await expect(await ready(other)).not.toContainText(unsaved, { timeout: 5_000 });

    // The enforcement. Carl's own page, Carl's own ticket, a frame built by hand and
    // sent past every disabled button in his UI.
    expect(await refused(other)).toBe(4403);

    // The same frame from a writer's page must NOT be refused, or the assertion above
    // would only prove that the endpoint refuses everyone, always.
    expect(await refused(bona)).not.toBe(4403);
  });

  test('a remote cursor renders in the other browser', async () => {
    await login(bona, 'bona');
    await login(other, 'bona');
    await openDocument(bona, RUNBOOK_TITLE);
    await openDocument(other, RUNBOOK_TITLE);
    await ready(bona);
    await ready(other);

    const editor = await ready(other);
    await editor.click();
    await other.keyboard.press('Control+End');

    // The label text comes from the awareness record the *server* stamped from the
    // verified credential, so this asserts the identity path as well as the plugin.
    const caret = bona.locator('[data-testid=remote-caret]').first();
    await expect(caret).toBeVisible({ timeout: 15_000 });
    // Seeded display names are full names ("Bora Novák"), and the value is the
    // server-stamped `displayName` — not the client's guess at its own label.
    await expect(caret).toHaveAttribute('data-user', 'Bora Novák');
  });

  test('the save indicator settles, and typing then publishing snapshots the keystroke', async () => {
    await login(bona, 'bona');
    await openDocument(bona, RUNBOOK_TITLE);

    const marker = `publikace-${Date.now()}`;
    await typeAtEnd(bona, marker);
    await expect(bona.getByTestId('save-state')).toHaveText('Uloženo', { timeout: 20_000 });

    const versions = bona.locator('.versions > li');
    await expect(versions).toHaveCount(1, { timeout: 10_000 });

    await bona.getByTestId('publish').click();
    await expect(versions).toHaveCount(2, { timeout: 15_000 });

    // The reason `flushNow` exists: persistence is debounced, so publishing without
    // the explicit flush would snapshot the document as of the last debounce window
    // and lose this marker from an immutable version permanently. Open v2 and look.
    await bona.locator('.versions button.num', { hasText: 'v2' }).click();
    // The snapshot's own Markdown. Reading the version rather than the editor is the
    // point: the editor always shows the marker, so asserting there proves nothing.
    await expect(bona.locator('.snapshot')).toContainText(marker, { timeout: 10_000 });

    // SPEC.md §2 names the pair; the pending half is visible the whole time a write
    // is in flight, so it is checked where it is permanent: a reader never sees
    // "Ukládám…", and a writer does while the debounce runs. Here it must settle to
    // the honest value rather than stay pending.
    await expect(bona.getByTestId('save-state')).toHaveText('Uloženo');
    await expect(bona.locator('.mode-hint')).toContainText('koncept');
  });

  test('a new heading gets an anchor, and its deep link survives a reload', async () => {
    await login(bona, 'bona');
    await openDocument(bona, RUNBOOK_TITLE);

    // Focus first. `ready()` waits for the indicator but does not move the caret,
    // and Control+End with focus on the page chrome leaves the cursor at the very
    // start of the document — where Enter then split the *seeded heading* and the
    // typed text landed inside it, which looked like an anchor bug and was a test bug.
    const before = (await surface(bona).innerText()).length;
    await typeAtEnd(bona, ' ');
    await bona.keyboard.press('Enter');
    await bona.getByRole('button', { name: 'Nadpis' }).click();
    const headingText = `Nová sekce ${Date.now()}`;
    await bona.keyboard.type(headingText);
    void before;

    const heading = surface(bona).locator('h2').last();
    await expect(heading).toHaveText(headingText);
    const anchor = await heading.getAttribute('data-anchor');
    // Generated at creation, by UniqueID, and of the shared shape the backend's seed
    // path produces too (PLAN §2.4).
    expect(anchor, 'a new heading must arrive with an anchor').toMatch(/^h-[a-z0-9]{8}$/);

    await bona.getByTestId('copy-heading-link').click();
    await expect(bona.getByTestId('notice')).toContainText(anchor ?? '');

    // The URL is the shareable form: document in the path, anchor in the hash.
    const url = bona.url();
    expect(url).toContain(`#${anchor}`);

    await revisit(bona, url);
    const relinked = bona.locator(`[data-anchor="${anchor}"]`);
    await expect(relinked).toBeVisible({ timeout: 20_000 });
    // The same anchor after a full round trip — the one property a text-derived slug
    // cannot promise, since the text is now in the URL and the URL in the text.
    expect(await relinked.getAttribute('data-anchor')).toBe(anchor);

    // Renaming the heading must not change it. This is the requirement, stated as the
    // failure it exists to prevent.
    await relinked.click();
    await bona.keyboard.press('End');
    await bona.keyboard.type(' přejmenováno');
    await expect(surface(bona).locator(`[data-anchor="${anchor}"]`)).toContainText('přejmenováno');
    expect(await surface(bona).locator(`[data-anchor="${anchor}"]`).getAttribute('data-anchor')).toBe(anchor);
  });

  test('a cross-document reference shows the target after it is republished', async () => {
    await login(bona, 'bona');
    await openDocument(bona, RUNBOOK_TITLE);

    // A reference from the runbook to the runbook's own seeded heading. Same resolve
    // path as a cross-document one (the endpoint takes `document#anchor` and has no
    // notion of who wrote what), and it keeps every fixture document writable — a
    // reference into the HR handbook could be *rendered* by Bona but never
    // republished by her, which is the half of SPEC §2.5 being tested here.
    await typeAtEnd(bona, 'odkaz níže');
    await bona.getByTestId('insert-reference').click();
    await bona.locator('input[aria-label="Cílový dokument"]').fill('deploy-runbook');
    await bona.locator('input[aria-label="Cílový oddíl"]').fill('sec-1');
    await bona.getByRole('button', { name: 'Vložit' }).click();

    const reference = bona.locator('.doc-ref').first();
    await expect(reference).toHaveAttribute('data-resolved', 'ok', { timeout: 20_000 });
    await expect(reference).toContainText('Obsah');
    // The version *number* is relative: these specs share one seeded database and
    // other tests publish too, so this asserts "the version the reference names is
    // the one it resolves from" and then that it moves — not a literal v1.
    const versionBefore = /v(\d+)$/.exec((await reference.getAttribute('title')) ?? '')?.[1];
    expect(versionBefore, 'the reference should name a version').toBeTruthy();

    // Rename the target heading and publish, then reload. The reference must follow.
    const target = surface(bona).locator('h1').first();
    await target.click();
    await bona.keyboard.press('Home');
    await bona.keyboard.press('Shift+End');
    await bona.keyboard.type('Obsah po publikovani');
    await bona.getByTestId('publish').click();
    await expect(bona.locator('.versions > li')).toHaveCount(2, { timeout: 15_000 });

    await revisit(bona, bona.url());
    const after = bona.locator('.doc-ref').first();
    await expect(after).toHaveAttribute('data-resolved', 'ok', { timeout: 20_000 });
    // PLAN §2.5: the target's *current published* content, never a stored copy. A
    // node that cached text would still read "Obsah" here and the test would be
    // asserting a snapshot, which is the thing §2.5 forbids.
    await expect(after).toContainText('Obsah po publikovani', { timeout: 20_000 });
    const versionAfter = /v(\d+)$/.exec((await after.getAttribute('title')) ?? '')?.[1];
    // It followed the target to a *newer* version rather than re-reading the old one.
    expect(Number(versionAfter)).toBe(Number(versionBefore) + 1);
  });
});
