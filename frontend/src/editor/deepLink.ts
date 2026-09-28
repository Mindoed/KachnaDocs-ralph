import { ref, watch } from 'vue';

/**
 * The URL, as the editor sees it: `/d/<document>#<anchor>`.
 *
 * ## Why the document id lives in the path
 *
 * A deep link to a heading is a *permanent* artifact — SPEC.md §2 asks for a stable
 * heading id precisely so a section can be quoted in a chat message, and PLAN §2.4
 * makes the anchor immutable for the same reason. Putting the document in a query
 * string (`/?doc=…`) would work identically today and would break the moment anyone
 * wanted to write a link by hand, so the path form is chosen for being the one that
 * does not change later.
 *
 * The anchor goes in the hash because that is the one part the browser will not
 * send to the server, and it must not: the anchor selects a heading inside a
 * client-rendered document, and a server that saw it would be tempted to resolve it
 * — which for a *draft* would disclose content the reader may not be entitled to.
 *
 * ## Why not vue-router
 *
 * It is a dependency, and it would still be the wrong tool here: this app has one
 * screen. A router's job is swapping views, and what changes between `/` and
 * `/d/x#h-abc` is which document a single, unchanged workbench has selected. Forty
 * lines of `popstate` and a ref make that explicit; a route table with one entry and
 * no `<router-view>` would be a router used as a URL parser, with its bundle cost and
 * none of its purpose.
 */
export interface Route {
  documentId: string | null;
  anchor: string | null;
}

const PREFIX = '/d/';

function read(): Route {
  const path = window.location.pathname;
  const documentId = path.startsWith(PREFIX) ? decodeURIComponent(path.slice(PREFIX.length)) : null;
  const hash = window.location.hash;
  return {
    documentId: documentId && documentId.length > 0 ? documentId : null,
    anchor: hash.length > 1 ? decodeURIComponent(hash.slice(1)) : null,
  };
}

export const route = ref<Route>(read());

function sync(): void {
  route.value = read();
}

window.addEventListener('popstate', sync);
window.addEventListener('hashchange', sync);

/**
 * Point the URL at a document, optionally at one heading in it.
 *
 * `replace` rather than `push` for anchor movement: every caret move onto another
 * heading would otherwise add a history entry, and Back would then step through the
 * document's headings instead of leaving it. Back is a way out of a document, not a
 * way to re-read the previous heading.
 */
export function openDocument(documentId: string | null, anchor?: string | null, push = false): void {
  const path = documentId ? `${PREFIX}${encodeURIComponent(documentId)}` : '/';
  const hash = anchor ? `#${encodeURIComponent(anchor)}` : '';
  const url = `${path}${hash}${window.location.search}`;
  if (window.location.pathname + window.location.hash === path + hash) return;
  if (push) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
  sync();
}

/**
 * Scroll to an anchor once, then let the URL be.
 *
 * The one-shot matters. A watcher that kept scrolling to `route.anchor` would fight
 * the reader: any scroll they did afterwards would snap them back the next time
 * something re-ran the watch. So the panel calls this when a link *arrives* (on
 * load, or on a hashchange from a pasted link), and clears nothing else.
 */
export async function scrollToAnchor(anchor: string | null, retries = 20): Promise<boolean> {
  if (!anchor) return false;
  for (let i = 0; i < retries; i += 1) {
    const el =
      document.getElementById(anchor) ?? document.querySelector(`[data-anchor="${cssEscape(anchor)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.setAttribute('data-target', 'true');
      return true;
    }
    // The editor renders after the first sync round trip, and a deep link arrives
    // before that. Polling a frame at a time beats guessing a timeout: the retry
    // ends the instant the heading exists, whether that is 20ms or 800ms.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * Anchors are generated from a small alphabet, so this is belt-and-braces — but an
 * anchor can also be hand-written in a document's Markdown, and a quote in one would
 * otherwise throw from `querySelector` and take the panel's render down with it.
 */
function cssEscape(value: string): string {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

/** True when this route names the given document — used to adopt a deep-linked selection. */
export function routeNames(documentId: string): boolean {
  return route.value.documentId === documentId;
}

/** Keep the URL's document half in step with the tree's selection. */
export function followSelection(selectedId: { value: string | null }): void {
  watch(
    () => selectedId.value,
    (id) => {
      // A null selection means "nothing chosen yet", not "go home": rewriting the
      // URL to / would throw away the deep link the page was loaded with before the
      // CMS list had even arrived.
      if (id && route.value.documentId !== id) openDocument(id);
    },
  );
}
