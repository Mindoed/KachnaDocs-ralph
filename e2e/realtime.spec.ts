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
 * ## Every document here is created by the test that uses it
 *
 * Not from `backend/src/seed.ts`. The seeded fixtures are `workbench.spec.ts`'s
 * subject and it asserts their immutability — the runbook has exactly one version and
 * its draft diffs against its published text with +0/−0. This suite types in
 * documents and publishes them, so sharing those rows broke both files: the runbook's
 * diff grew a line, and the presence list counted phase 2's editor as a collaborator.
 * `workers: 1` in `playwright.config.ts` makes that collision deterministic rather
 * than intermittent, which is precisely why it can no longer be lived with.
 *
 * So each test mints its own documents over the API and deletes them afterwards
 * (`owned`), and the only seeded things used here are the *users* — Bona, who can
 * write inside Engineering, and Carl, who holds one direct READ grant that this suite
 * never needs to touch.
 */

/** Mirrors `playwright.config.ts`; Node-side fixture calls cannot use Playwright's baseURL. */
const ORIGIN = process.env.E2E_ORIGIN ?? `http://127.0.0.1:${process.env.E2E_PORT ?? '3100'}`;

/** Engineering — the group Bona MANAGEs, so documents created there are hers to publish. */
const ENGINEERING = 'bbbbbbb3-0000-0000-0000-000000000000';
/** Carl, who must be granted READ per document (he has no role that reaches Engineering). */
const CARL = '33333333-3333-3333-3333-333333333333';

interface OwnedDocument {
  id: string;
  slug: string;
}

const tokens = new Map<string, string>();

/** A dev-login token for Node, so fixtures are built by the API rather than by SQL. */
async function tokenFor(handle: string): Promise<string> {
  const cached = tokens.get(handle);
  if (cached) return cached;
  const res = await fetch(`${ORIGIN}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) throw new Error(`dev-login ${handle} failed: ${res.status}`);
  const { token } = (await res.json()) as { token: string };
  tokens.set(handle, token);
  return token;
}

/**
 * An API call made as `handle`.
 *
 * Fixtures go through HTTP rather than `query()` on purpose: a document inserted with
 * raw SQL would bypass whatever the create path decides about slugs, ownership and
 * the empty draft, and the suite would then be testing a shape the product cannot
 * produce.
 */
async function as<T>(handle: string, method: string, path: string, payload?: unknown): Promise<T> {
  const res = await fetch(`${ORIGIN}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await tokenFor(handle)}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** A ProseMirror doc: heading with a known anchor, then one paragraph per string. */
function pmDoc(paragraphs: string[], heading = 'Obsah'): unknown {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { anchor: 'sec-1', level: 1 }, content: [{ type: 'text', text: heading }] },
      ...paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
    ],
  };
}

/**
 * Creates a document this test owns, and arranges for it to be removed.
 *
 * Deletion happens in `afterEach` against a per-test list rather than inline, because
 * an assertion that fails halfway would otherwise leave the row behind for the rest of
 * the run — which is exactly the residue that made the seeded fixtures unusable.
 */
let owned: OwnedDocument[] = [];
async function ownDoc(title: string): Promise<OwnedDocument> {
  const created = await as<OwnedDocument>('bona', 'POST', '/documents', {
    title: `${title} ${Date.now()}`,
    groupId: ENGINEERING,
  });
  owned.push(created);
  return created;
}

/** Publishes the document's current draft as its next version. */
async function publishAs(handle: string, id: string): Promise<void> {
  await as(handle, 'POST', `/documents/${id}/publish`, { comment: 'e2e' });
}

/**
 * Writes a draft from outside the editor.
 *
 * `PUT /draft` rather than typing: the reader tests need a draft that differs from the
 * published version *before* anybody connects, and typing it in first would mean a
 * writer's websocket produced the difference — which is the case the live-typing
 * assertion covers, not this one.
 */
async function putDraft(id: string, paragraphs: string[], heading = 'Obsah'): Promise<void> {
  await as('bona', 'PUT', `/documents/${id}/draft`, {
    body: pmDoc(paragraphs, heading),
    markdown: `# ${heading}\n\n${paragraphs.join('\n\n')}`,
  });
}

async function grantCarlRead(id: string): Promise<void> {
  await as('bona', 'POST', '/permissions', {
    subjectKind: 'user',
    subjectId: CARL,
    targetKind: 'document',
    targetId: id,
    permission: 'READ',
  });
}

/** Signs in through the dev login form, as a user would. */
async function login(page: Page, handle: string): Promise<void> {
  await page.goto('/');
  await page.fill('input[autocomplete="username"]', handle);
  await page.getByRole('button', { name: /Přihlásit se/ }).click();
  await expect(page.locator('footer.status')).toBeVisible();
}

/**
 * Opens one of this test's documents by id.
 *
 * A direct navigation rather than a tree click: the tree is phase 2's UI, it is already
 * covered there, and clicking a row whose title embeds `Date.now()` would make every
 * failure in this file a locator problem. The URL is also the shape a deep link
 * arrives as, which is what the anchor tests need anyway.
 */
async function openDocument(page: Page, id: string): Promise<void> {
  await page.goto(`/d/${encodeURIComponent(id)}`);
  await expect(surface(page)).toBeVisible();
}

/** Returns to a URL after a reload, *without* signing in again. */
async function revisit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('footer.status')).toBeVisible();
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
 *   harness's choice.
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
    owned = [];
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    bona = await contextA.newPage();
    other = await contextB.newPage();
  });

  test.afterEach(async () => {
    await contextA.close();
    await contextB.close();
    // Deleted after the browsers are gone: a live websocket holds the room open, and
    // `discard` on a document with connections is a different path than deleting one
    // that nobody is in. Closing first keeps teardown on the ordinary path.
    for (const doc of owned.splice(0)) {
      await as('bona', 'DELETE', `/documents/${doc.id}`).catch(() => null);
    }
  });

  test('what one writer types appears in the other without a reload', async () => {
    const doc = await ownDoc('Sync');
    await login(bona, 'bona');
    await login(other, 'bona');
    await openDocument(bona, doc.id);
    await openDocument(other, doc.id);

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

  /**
   * Place the caret inside the paragraph containing `needle`, and *prove* it landed.
   *
   * This helper exists because a bare `click()` + Home was measurably a coin flip: in
   * 8 of 20 instrumented runs the typed note landed at the very start of the
   * document's heading (`poznamka AObsah`) — the click had not moved the caret, so
   * Home/Enter applied to wherever the selection actually was (the doc start, from
   * mount), and the writer split the heading instead of their paragraph. The Yjs
   * merge then had nothing to do with the failure; the test had simply typed into a
   * different block than it claimed.
   *
   * So: click, read the caret back from the DOM selection, retry until the caret's
   * closest `p` is the one we aimed at. The precondition the test was previously
   * assuming is now an assertion with retries — if placement keeps failing, that is
   * what the failure says, instead of a misleading "Yjs lost an edit".
   */
  async function caretInParagraph(page: Page, needle: string): Promise<void> {
    const editor = page.locator('[data-testid=editor-host] .tiptap');
    const caretParagraph = (): Promise<string> =>
      page.evaluate(() => {
        const node = window.getSelection()?.anchorNode ?? null;
        if (!node) return '';
        const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
        return el?.closest('p')?.textContent ?? '';
      });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await editor.locator('p', { hasText: needle }).click();
      // ProseMirror mirrors DOM selection into its own state on a microtask; give the
      // read-back one tick or we would be racing our own click.
      await page.waitForTimeout(25);
      if ((await caretParagraph()).includes(needle)) return;
    }
    throw new Error(`caret never landed in the paragraph containing "${needle}"`);
  }

  test('simultaneous edits in different places both survive', async () => {
    // Two paragraphs, and one writer per paragraph.
    //
    // This test used to press Control+End in *both* browsers, which put the two
    // inserts at the same offset and made the title a lie. Yjs still lost nothing
    // there — a concurrent insert at one position is exactly what its transform
    // handles — but it does not promise the two survive contiguously, so the merged
    // text came out `spolecny-…780 poznamka A0 poznamka B`: the seed's tail had been
    // split by the other writer's paragraph. That is correct behaviour, and the
    // assertion was over-specified — it read a contiguity requirement into a CRDT that
    // makes a weaker, honest guarantee.
    //
    // Editing separate blocks is both the claim in the title and the case a last
    // -writer-wins implementation actually loses, so the assertions below can be
    // strict about order without depending on how a tie is broken.
    const first = `odstavec-jeden-${Date.now()}`;
    const second = `odstavec-dva-${Date.now()}`;
    const doc = await ownDoc('Merge');
    await putDraft(doc.id, [first, second]);
    await login(bona, 'bona');
    await login(other, 'bona');
    await openDocument(bona, doc.id);
    await openDocument(other, doc.id);
    await ready(bona);
    await ready(other);

    // Both writers type without either waiting for the other, so the two updates are
    // genuinely in flight at the same time rather than arriving in the order typed.
    //
    // Each writer's position is pinned to a *named block whose ownership of the
    // caret is verified before anything is typed* (`caretInParagraph`), which
    // replaces two earlier shapes. The original pressed a centre click + Home, and
    // a centre click focuses wherever the editable's midpoint happens to fall:
    // measurably often (8 runs in 20 in an instrumented repeat) the click never
    // moved the caret at all, Home/Enter applied to the selection mount had left
    // at the document start, and the note landed as heading text — the snapshot
    // showed `heading "poznamka AObsah"` — so the test failed on a run where Yjs
    // had lost nothing. Pinning to a block by clicking it was the right idea and
    // still assumed the click took. Verifying the DOM selection after the click is
    // what makes "each writer owns their paragraph" a fact the test checks rather
    // than hopes.
    await Promise.all([
      (async () => {
        await caretInParagraph(bona, first);
        await bona.keyboard.press('Home');
        await bona.keyboard.press('Enter');
        await bona.keyboard.type('poznamka A');
      })(),
      (async () => {
        await caretInParagraph(other, second);
        await other.keyboard.press('Control+End');
        await other.keyboard.press('Enter');
        await other.keyboard.type('poznamka B');
      })(),
    ]);

    for (const page of [bona, other]) {
      const editor = await ready(page);
      // Each note sits in its own block, which is what "both survived" means when the
      // blocks were different: neither overwrote the other.
      //
      // 15 s, matching the cross-peer waits above: these assertions are the first
      // look the *other* browser gets at each note, so they are sync assertions and
      // deserve the same patience. (They initially went to 15 s chasing a diagnosis
      // that turned out to be wrong — the real cause was caret placement, fixed in
      // `caretInParagraph` — but the relaxed budget is right on its own merits and
      // was kept after re-measurement.)
      await expect(editor.locator('p', { hasText: 'poznamka A' })).toHaveCount(1, { timeout: 15_000 });
      await expect(editor.locator('p', { hasText: 'poznamka B' })).toHaveCount(1, { timeout: 15_000 });
      await expect(editor).toContainText(first, { timeout: 15_000 });
      await expect(editor).toContainText(second, { timeout: 15_000 });
    }
  });

  test('the presence list names the collaborators on both sides', async () => {
    const doc = await ownDoc('Presence');
    await login(bona, 'bona');
    await login(other, 'bona');
    await openDocument(bona, doc.id);
    await openDocument(other, doc.id);

    // Both directions on purpose: "shows the other person" and "shows me too" are
    // different bugs, and a list that renders only yourself looks correct in a
    // single-browser test forever.
    const chips = bona.getByTestId('presence').locator('.chip');
    await expect(chips).toHaveCount(2, { timeout: 15_000 });
    await expect(other.getByTestId('presence').locator('.chip')).toHaveCount(2, { timeout: 15_000 });
  });

  test('a READ-only user is refused by the server, not by the toolbar', async () => {
    const doc = await ownDoc('Readonly');
    // The published text and the draft have to differ *before anyone connects*, so the
    // leak this tests for cannot be attributed to a websocket race. Written through the
    // draft endpoint, which is also the only way to make the two differ without a
    // writer's session having produced the difference first.
    await putDraft(doc.id, ['Publikovana cast textu.']);
    await publishAs('bona', doc.id);
    await putDraft(doc.id, ['Publikovana cast textu.', `rozpracovano-${Date.now()}`]);
    await grantCarlRead(doc.id);

    await login(bona, 'bona');
    await login(other, 'carl');
    await openDocument(bona, doc.id);
    await openDocument(other, doc.id);

    // The affordance, asserted because SPEC.md §2 asks for READ to be respected in
    // the UI too — but never asserted as the reason anything is safe.
    await expect(other.getByTestId('toolbar')).toHaveCount(0);
    await expect(bona.getByTestId('toolbar')).toBeVisible();
    await expect(other.getByTestId('save-state')).toHaveText('Režim jen pro čtení');
    await expect(other.locator('[data-testid=editor-host] .tiptap')).toHaveAttribute(
      'contenteditable',
      'false',
    );

    // What the reader was handed: the published version, not the draft sitting beside
    // it. Asserted on text that exists only in the draft, so a reader's document that
    // came from the room — which is what it used to — contains it and fails here.
    const draftOnly = /rozpracovano-\d+/;
    await expect(other.locator('[data-testid=editor-host]')).not.toContainText(draftOnly);
    await expect(bona.locator('[data-testid=editor-host]')).toContainText(draftOnly);

    // And live typing does not reach them either, one keystroke at a time.
    const unsaved = `zivote-${Date.now()}`;
    await typeAtEnd(bona, unsaved);
    await expect(await ready(other)).not.toContainText(unsaved, { timeout: 5_000 });

    // The enforcement. Carl's own page, Carl's own ticket, a frame built inside the
    // browser and sent past every disabled button in his UI.
    expect(await refused(other)).toBe(4403);

    // The same frame from a writer's page must NOT be refused, or the assertion above
    // would only prove that the endpoint refuses everyone, always.
    expect(await refused(bona)).not.toBe(4403);
  });

  test('a reader learns about a publish and their view becomes the new version', async () => {
    // SPEC.md §1: "Publikování … informuje ostatní klienty o změně." Phase 2 deferred
    // this bullet to phase 3's transport; this is where it lands.
    //
    // Asserted in a browser because the interesting part is not "did the server say a
    // new version exists" — it is what the reader's *document* ends up holding, and
    // reconnecting is not enough to get it right. The provider keeps one Y.Doc across
    // reconnects, so re-syncing a newer snapshot into a doc that already holds the
    // older version merges them: heading twice, both paragraphs, both bodies. With the
    // client-side rebuild removed this test fails as
    // "Obsah publikace-dva-… Obsah publikace-jedna-…".
    //
    // Hence the second half of the assertion: the old text must be *gone*, not merely
    // joined by new text. `toContainText(v2)` alone passes on a merged document.
    const doc = await ownDoc('Naslouchani');
    const v1 = `publikace-jedna-${Date.now()}`;
    await putDraft(doc.id, [v1]);
    await publishAs('bona', doc.id);
    await grantCarlRead(doc.id);

    await login(other, 'carl');
    await openDocument(other, doc.id);
    await expect(await ready(other)).toContainText(v1);

    // A second version, published from Node so there is no doubt about ordering: the
    // reader is connected and idle when it lands.
    const v2 = `publikace-dva-${Date.now()}`;
    await putDraft(doc.id, [v2]);
    await publishAs('bona', doc.id);

    // The poll runs every two seconds; the rebuild it triggers remounts the editor, so
    // this waits on content rather than on `ready()` — whose reader label "Režim jen
    // pro čtení" is true before the notification is even acted on.
    const readerSurface = surface(other);
    await expect(readerSurface).toContainText(v2, { timeout: 20_000 });
    // The half that a "new content arrived" assertion would miss entirely: if the
    // client had merged the new version into the doc it already had, v1 would still be
    // on screen beside v2 and the line above would pass.
    await expect(readerSurface).not.toContainText(v1);
    const shown = await readerSurface.innerText();
    expect(shown).toContain(v2);
    expect(shown).not.toContain(v1);
  });

  test('a remote cursor renders in the other browser', async () => {
    const doc = await ownDoc('Caret');
    // Content, deliberately. A freshly created document is `{doc, content: []}`, which
    // Tiptap normalises to one empty paragraph — and a caret has no coordinates to
    // render at inside it, so this test would fail for a reason that has nothing to do
    // with awareness. Real documents have text; the caret needs somewhere to be.
    await putDraft(doc.id, ['První odstavec.', 'Druhý odstavec.']);
    await login(bona, 'bona');
    await login(other, 'bona');
    await openDocument(bona, doc.id);
    await openDocument(other, doc.id);
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
    const doc = await ownDoc('Publish');
    // Two blocks so the caret's destination is unambiguous, and a draft that exists
    // before the page opens — the same shape a document reopened mid-edit has.
    await putDraft(doc.id, ['První odstavec.']);
    await login(bona, 'bona');
    await openDocument(bona, doc.id);

    const marker = `publikace-${Date.now()}`;
    await typeAtEnd(bona, marker);
    await expect(bona.getByTestId('save-state')).toHaveText('Uloženo', { timeout: 20_000 });

    // A document this test created has no history at all, so the version it gains is
    // v1 and there is no earlier test's publishing to count against it. That is the
    // point of owning the fixture: the arithmetic is this test's alone.
    const versions = bona.locator('.versions > li');
    await expect(versions).toHaveCount(0, { timeout: 10_000 });

    await bona.getByTestId('publish').click();
    await expect(versions).toHaveCount(1, { timeout: 15_000 });

    // The reason `flushNow` exists: persistence is debounced, so publishing without
    // the explicit flush would snapshot the document as of the last debounce window
    // and lose this marker from an immutable version permanently. Open v1 and look.
    await bona.locator('.versions button.num', { hasText: 'v1' }).click();
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
    const doc = await ownDoc('Anchory');
    await login(bona, 'bona');
    await openDocument(bona, doc.id);

    // Focus first. `ready()` waits for the indicator but does not move the caret,
    // and Control+End with focus on the page chrome leaves the cursor at the very
    // start of the document — where Enter then split the *seeded heading* and the
    // typed text landed inside it, which looked like an anchor bug and was a test bug.
    await typeAtEnd(bona, ' ');
    await bona.keyboard.press('Enter');
    await bona.getByRole('button', { name: 'Nadpis' }).click();
    const headingText = `Nová sekce ${Date.now()}`;
    await bona.keyboard.type(headingText);

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
    // Two documents, because "cross-document" is the thing under test: a reference into
    // the *same* document would pass with a resolver that simply re-read the local
    // fragment, and it was the shape the first version of this test accidentally had.
    const target = await ownDoc('Cil');
    const viewer = await ownDoc('Odkazujici');
    await putDraft(target.id, ['Cizí dokument.']);
    await publishAs('bona', target.id);

    await login(bona, 'bona');
    await login(other, 'bona');
    await openDocument(bona, viewer.id);

    await typeAtEnd(bona, 'odkaz níže');
    await bona.getByTestId('insert-reference').click();
    await bona.locator('input[aria-label="Cílový dokument"]').fill(target.slug);
    await bona.locator('input[aria-label="Cílový oddíl"]').fill('sec-1');
    await bona.getByRole('button', { name: 'Vložit' }).click();

    const reference = bona.locator('.doc-ref').first();
    await expect(reference).toHaveAttribute('data-resolved', 'ok', { timeout: 20_000 });
    await expect(reference).toContainText('Obsah');
    const versionBefore = /v(\d+)$/.exec((await reference.getAttribute('title')) ?? '')?.[1];
    expect(versionBefore, 'the reference should name a version').toBeTruthy();

    // Rename the target's heading and publish it, from the second browser. The viewer
    // is never touched, so the only way the new text can appear there is by resolving
    // the target again — which is PLAN §2.5 in one sentence.
    await openDocument(other, target.id);
    const heading = (await ready(other)).locator('h1').first();
    await heading.click();
    await other.keyboard.press('Home');
    await other.keyboard.press('Shift+End');
    await other.keyboard.type('Obsah po publikovani');
    await publishAs('bona', target.id);

    await revisit(bona, `/d/${encodeURIComponent(viewer.id)}`);
    const after = bona.locator('.doc-ref').first();
    await expect(after).toHaveAttribute('data-resolved', 'ok', { timeout: 20_000 });
    await expect(after).toContainText('Obsah po publikovani', { timeout: 20_000 });
    const versionAfter = /v(\d+)$/.exec((await after.getAttribute('title')) ?? '')?.[1];
    // It followed the target to a *newer* version rather than re-reading the old one.
    expect(Number(versionAfter)).toBe(Number(versionBefore) + 1);
  });
});
