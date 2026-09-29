import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * SPEC §5 in a browser: ask, be answered from the permitted corpus, click a
 * citation, land on the heading it named.
 *
 * ## What this file can prove that `backend/test/ai.e2e-spec.ts` cannot
 *
 * The jest suite owns the security claims — the ACL at the SQL level, non-disclosure,
 * the threshold — over real HTTP with no browser in sight. What it structurally
 * cannot see is the half that lives in the page: a citation chip that carries the
 * right anchor but navigates to `/d/<wrong-id>`, a message list that renders the
 * answer but drops the citations, a composer that sends the question twice, the panel
 * that works on first load and dies on the second question. Those are the failures a
 * panel review sees as "the AI tab is broken" whatever the API said, and they are all
 * in this file.
 *
 * ## And what it deliberately does not re-prove
 *
 * The no-disclosure assertions here are *rendering* claims — a forbidden title must
 * not appear in the panel's DOM — and they are paired exactly as the jest suite pairs
 * them: the same corpus demonstrably answers the same question for someone else
 * first. A DOM that shows nothing would also satisfy a leak test run blind, which is
 * the trap this phase's corpus makes unavoidable: a refusal is a valid answer.
 *
 * ## Corpus discipline (the phase-2/3 lesson, third telling)
 *
 * Every answerable fact here is published into a document this test owns and then
 * deleted. The seeded runbook is used read-only — its published text and single
 * version are asserted by two other suites. The question for an owned document
 * embeds a `Date.now()` marker, so a leftover row from a crashed run cannot make this
 * suite pass on stale content.
 */

const ORIGIN = process.env.E2E_ORIGIN ?? `http://127.0.0.1:${process.env.E2E_PORT ?? '3100'}`;
const ENGINEERING = 'bbbbbbb3-0000-0000-0000-000000000000';
/** The HR handbook — Ana reads it (HR role, inherited), Bona does not. */
const HANDBOOK = 'ccccccc1-0000-0000-0000-000000000000';

const tokens = new Map<string, string>();

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

function pmDoc(paragraphs: string[], heading: string, anchor: string): unknown {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { anchor, level: 1 }, content: [{ type: 'text', text: heading }] },
      ...paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
    ],
  };
}

interface Owned {
  id: string;
}
let owned: Owned[] = [];

/** A published, indexed document this test owns. Publish is what indexes it. */
async function ownPublished(paragraphs: string[], heading: string, anchor: string): Promise<Owned> {
  const doc = await as<Owned>('bona', 'POST', '/documents', {
    title: `AI ${heading} ${Date.now()}`,
    groupId: ENGINEERING,
  });
  owned.push(doc);
  await as('bona', 'PUT', `/documents/${doc.id}/draft`, {
    body: pmDoc(paragraphs, heading, anchor),
    markdown: `# ${heading} {data-anchor="${anchor}"}\n\n${paragraphs.join('\n\n')}`,
  });
  await as('bona', 'POST', `/documents/${doc.id}/publish`, { comment: 'e2e ai' });
  return doc;
}

/**
 * A published document whose anchor heading sits *below the fold*.
 *
 * The citation test needs a document long enough that reaching the heading requires
 * scrolling. On a two-block document every heading is already on screen, so "did the
 * citation scroll me to the anchor?" is answered yes by a feature that does nothing —
 * a test that cannot fail is worse than no test, and this is exactly the shape the
 * empty-then-scroll bug hid behind.
 */
async function ownPublishedWithHeadingBelowFold(
  heading: string,
  anchor: string,
  answer: string,
): Promise<Owned> {
  const filler = Array.from({ length: 40 }, (_, i) => `Odstavec numerovaný ${i}.`);
  const doc = await as<Owned>('bona', 'POST', '/documents', {
    title: `AI ${heading} ${Date.now()}`,
    groupId: ENGINEERING,
  });
  owned.push(doc);
  const body = {
    type: 'doc',
    content: [
      ...filler.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
      { type: 'heading', attrs: { anchor, level: 1 }, content: [{ type: 'text', text: heading }] },
      { type: 'paragraph', content: [{ type: 'text', text: answer }] },
    ],
  };
  await as('bona', 'PUT', `/documents/${doc.id}/draft`, {
    body,
    markdown: `${filler.join('\n\n')}\n\n# ${heading} {data-anchor="${anchor}"}\n\n${answer}`,
  });
  await as('bona', 'POST', `/documents/${doc.id}/publish`, { comment: 'e2e ai' });
  return doc;
}

async function login(page: Page, handle: string): Promise<void> {
  await page.goto('/');
  await page.fill('input[autocomplete="username"]', handle);
  await page.getByRole('button', { name: /Přihlásit se/ }).click();
  await expect(page.locator('footer.status')).toBeVisible();
}

/**
 * Opens the chat panel from the ribbon.
 *
 * Matched on `title`, not by accessible name: the ribbon's buttons are single
 * glyphs (`✦`) whose label lives in the `title` attribute, so
 * `getByRole('button', { name: 'AI chat' })` finds nothing — the accessible name of
 * those buttons is the glyph. Matching the title prefix rather than the exact string
 * because the title also carries the dock (`"AI chat — right"`), which is layout
 * state this test must not depend on.
 */
async function openChat(page: Page): Promise<void> {
  await page.getByTitle(/^AI chat/).click();
  await expect(page.getByTestId('ai-messages')).toBeVisible();
}

const messages = (page: Page): Locator => page.getByTestId('ai-messages');
const input = (page: Page): Locator => page.getByTestId('ai-input');

async function ask(page: Page, question: string): Promise<void> {
  // Waiting on "an answer is on screen" is not waiting on *this* answer: a previous
  // turn already satisfies that, so a caller could assert against a stale reply while
  // this one is still in flight. Counting turns first makes the wait mean what it says.
  const before = await messages(page).locator('[data-role=assistant]').count();
  await input(page).fill(question);
  await page.getByTestId('ai-ask').click();
  await expect(messages(page).locator('[data-role=assistant]')).toHaveCount(before + 1, { timeout: 20_000 });
}

/** The assistant turn that answers — the last `[data-role=assistant]` block. */
const lastAnswer = (page: Page): Locator => messages(page).locator('[data-role=assistant]').last();

test.beforeEach(async ({ page }) => {
  await login(page, 'bona');
  await openChat(page);
});

test.afterEach(async () => {
  for (const doc of owned) await as('bona', 'DELETE', `/documents/${doc.id}`);
  owned = [];
});

test('an answer arrives with citation chips naming document and anchor', async ({ page }) => {
  const marker = `odpoved-${Date.now()}`;
  const doc = await ownPublished([`Postup zálohování: ${marker}.`], 'Zálohování', 'zal-1');

  await ask(page, `Postup zálohování ${marker}`);

  await expect(lastAnswer(page)).toContainText(marker, { timeout: 15_000 });
  const chip = lastAnswer(page).getByTestId('ai-citation').first();
  await expect(chip).toContainText('Zálohování');
  // The chip names the anchor it will open, so what it promises and what it does
  // can be compared by eye in a screenshot, not only by clicking.
  await expect(chip).toContainText('#zal-1');
  void doc;
});

test('clicking a citation opens the document at its heading', async ({ page }) => {
  const marker = `klik-${Date.now()}`;
  const doc = await ownPublishedWithHeadingBelowFold('Klíče', 'klice-9', `Kapitola o klíčích: ${marker}.`);

  await ask(page, `Kapitola o klíčích ${marker}`);
  await expect(lastAnswer(page)).toContainText(marker, { timeout: 15_000 });

  const chip = lastAnswer(page).getByTestId('ai-citation').first();

  // The heading must be *in the viewport*, which on this document means having
  // scrolled: it sits below forty filler paragraphs, so a citation that opened the
  // document without scrolling leaves it off-screen below the fold. The precondition
  // is asserted too, because without it the post-click check would be vacuous — on a
  // two-block document every heading starts on screen, and a feature that scrolled
  // nowhere at all would pass.
  //
  // This replaced an assertion on a `data-target="true"` attribute the scroller used
  // to stamp on the heading it had found. That assertion was wrong rather than merely
  // indirect: ProseMirror owns the DOM inside `.tiptap` and re-renders it on the next
  // sync, so the attribute was set correctly and then erased — the test failed while
  // the feature worked. Whether the reader can *see* the heading is the property, it
  // is owned by nobody's rendering internals, and it cannot be replaced by `scrollY`:
  // the element that scrolls here is the panel's `.dock-body`, not the window, which
  // never moves.
  expect(await headingState(page, 'klice-9'), 'heading must start below the fold').not.toBe('visible');

  await chip.click();

  // The URL is the contract — `/d/<document>#<anchor>` — and it is the same URL a
  // copied heading link produces, so the two paths cannot drift silently.
  await expect(page).toHaveURL(new RegExp(`/d/${doc.id}#klice-9`));
  // …and the editor actually rendered that document, rather than the URL changing
  // over a stale panel. The heading text is the proof it is the right version.
  const surface = page.locator('[data-testid=editor-host] .tiptap');
  await expect(surface).toContainText('Klíče', { timeout: 15_000 });

  await expect.poll(() => headingState(page, 'klice-9'), { timeout: 10_000 }).toBe('visible');
});

test('a citation for the document already on screen still scrolls it to the anchor', async ({ page }) => {
  const marker = `stejny-${Date.now()}`;
  const doc = await ownPublishedWithHeadingBelowFold('Certifikáty', 'cert-9', `Doba platnosti: ${marker}.`);

  // The document is open *before* the question is asked, which is what makes this a
  // different case from the test above. There, the click creates the editor session
  // and the session's own mount-time follow finds the anchor; here the session already
  // exists, so the only thing that can move the view is the URL change itself — and
  // `openDocument(..., push)` performs that with `history.pushState`, which fires no
  // `hashchange`. The first version of this feature listened for `hashchange` and so
  // changed the address bar and scrolled nothing: the reader stayed at paragraph one
  // of a document they had been told was open at a heading.
  await page.goto(`/d/${doc.id}`);
  const surface = page.locator('[data-testid=editor-host] .tiptap');
  await expect(surface).toContainText(marker, { timeout: 15_000 });

  await openChat(page);
  await ask(page, `Doba platnosti ${marker}`);
  await expect(lastAnswer(page)).toContainText(marker, { timeout: 15_000 });
  const chip = lastAnswer(page).getByTestId('ai-citation').first();
  await expect(chip).toContainText('#cert-9');

  // Precondition worth stating because without it the assertion below is vacuous: the
  // heading is off-screen before the click. Forty filler paragraphs put it there.
  expect(await headingState(page)).not.toBe('visible');

  await chip.click();

  await expect(page).toHaveURL(new RegExp(`/d/${doc.id}#cert-9`));
  await expect.poll(() => headingState(page), { timeout: 10_000 }).toBe('visible');
});

/** Where the anchor heading sits relative to the viewport, as the reader would judge it. */
function headingState(page: Page, anchor = 'cert-9'): Promise<string> {
  return page.evaluate((wanted) => {
    const heading = document.querySelector(`[data-testid=editor-host] [data-anchor="${wanted}"]`);
    if (!heading) return 'missing';
    const box = heading.getBoundingClientRect();
    return box.top >= 0 && box.top <= window.innerHeight ? 'visible' : `offscreen:${Math.round(box.top)}`;
  }, anchor);
}

test('an unanswerable question renders the admission, with no chips at all', async ({ page }) => {
  await ask(page, 'Kolik stojí pronájem satelitní stanice na Marsu?');
  const answer = lastAnswer(page);
  await expect(answer).toContainText('nepokrývá', { timeout: 15_000 });
  await expect(answer).toHaveAttribute('data-unanswerable', 'true');
  // The chip row is absent, not merely empty: "I don't know" beside three confident
  // sources is the worst possible rendering of this state.
  await expect(answer.getByTestId('ai-citation')).toHaveCount(0);
});

test('a forbidden document is never rendered to someone who may not read it', async ({ page }) => {
  // The pairing first: the same corpus answers for the person who *may* read it.
  // Without this line, "Bona's DOM contains no handbook title" would be equally
  // consistent with the handbook being absent from the index entirely.
  const asAna = await as<{ citations: { documentId: string }[] }>('ana', 'POST', '/ai/ask', {
    question: 'Základní pravidla personálu',
  });
  expect(asAna.citations.some((c) => c.documentId === HANDBOOK)).toBe(true);

  await ask(page, 'Základní pravidla personálu');
  await expect(lastAnswer(page)).toBeAttached({ timeout: 15_000 });
  // Every byte the panel holds — both turns, every chip, every tooltip — not just
  // the answer paragraph. A leak into a `title=` attribute is still a leak.
  await expect(messages(page)).not.toContainText('Příručka HR');
  await expect(page.content()).resolves.not.toContain(HANDBOOK);
});

test('the conversation survives a reload, in order, with its citations', async ({ page }) => {
  const marker = `reload-${Date.now()}`;
  await ownPublished([`Položka deníku: ${marker}.`], 'Deník', 'denik-1');

  await ask(page, `Položka deníku ${marker}`);
  await expect(lastAnswer(page)).toContainText(marker, { timeout: 15_000 });
  const chipText = await lastAnswer(page).getByTestId('ai-citation').first().innerText();
  expect(chipText).toContain('Deník');

  await page.reload();
  await openChat(page);
  // Restored from the server's history, not from component memory: after a reload
  // the panel is a brand-new object and the only copy of this exchange is the
  // `ai_messages` rows.
  const history = messages(page).locator('[data-role=assistant]');
  await expect(history.first()).toContainText(marker, { timeout: 15_000 });
  await expect(history.first().getByTestId('ai-citation').first()).toContainText('Deník');
});

test('a follow-up in the same conversation is answered where the same question alone was not', async ({
  page,
}) => {
  const marker = `navazba-${Date.now()}`;
  await ownPublished([`Doba platnosti certifikátu je ${marker} dní.`], 'Certifikáty', 'cert-1');

  // The fragment has to satisfy two constraints that pull against each other, which
  // is why it is worded so awkwardly. Alone it must retrieve *nothing* — so it may
  // share no word form with the document, given the embedder is lexical and
  // unstemmed by design. Merged onto the previous question it must clear the
  // threshold — so it must contribute a word the document does contain. "A co ten
  // certifikát?" is both: `certifikát` … does not match `certifikátu` as a feature,
  // while `doba`/`platnosti`/`dní` come from the prepended question. A bare "A jak
  // dlouho?" would fail the second half — merged, it still shares nothing.
  const fragment = 'A co ten certifikát?';

  // Cold: the fragment alone retrieves nothing.
  await ask(page, fragment);
  await expect(lastAnswer(page)).toHaveAttribute('data-unanswerable', 'true', { timeout: 15_000 });

  // Warm: the subject first, then the *same* fragment in the same conversation.
  await ask(page, `Doba platnosti certifikátu ${marker} dní`);
  await expect(lastAnswer(page)).toContainText(marker, { timeout: 15_000 });

  await ask(page, fragment);
  const warm = lastAnswer(page);
  await expect(warm).toContainText(marker, { timeout: 15_000 });
  await expect(warm).not.toHaveAttribute('data-unanswerable', 'true');
  // The note is the panel saying "this answer rests on the earlier turn", which is
  // the difference between an answer and a confident non-sequitur: the text quotes
  // certificate validity in reply to a question that named no duration.
  await expect(warm.locator('.context-note')).toBeVisible();
});
