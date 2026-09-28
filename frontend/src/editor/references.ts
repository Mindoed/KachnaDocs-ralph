import { Node, mergeAttributes } from '@tiptap/core';
import type { ResolvedHeadingDto } from '@kachnadocs/shared';
import { api } from '../api';

/**
 * A live reference to a heading in another document (PLAN §2.5).
 *
 * ## What is stored, and why that is the whole design
 *
 * The node stores `{ document, anchor }` and **no text**. Not "text as a cache
 * that gets refreshed" — no text at all. A stored copy of the target's heading is
 * a snapshot, and a snapshot is a lie the first time the target is republished;
 * §2.5 rules that out, and the test that earns it is
 * `e2e/realtime.spec.ts` ("shows updated target content after republish").
 *
 * So the visible text is *rendered*, by a NodeView, from a resolution that is
 * fetched per document load and held in memory for the lifetime of the view. Close
 * the tab, reopen, fetch again. Nothing about a reference outlives a load, which is
 * what makes "live" a property rather than a refresh policy.
 *
 * ## Why a NodeView and not `renderHTML`
 *
 * `renderHTML` runs synchronously against state that must already be final, and a
 * resolution is an HTTP request. A NodeView is the sanctioned place to put
 * something asynchronous on the screen: it owns its DOM element and can update
 * `textContent` when the answer arrives, without dispatching a transaction.
 * Dispatching one would be actively wrong — a reader with no WRITE would be
 * *editing the document* in order to display somebody else's heading, and even for
 * a writer it would write the target's text into the referring document, i.e. the
 * snapshot, by the back door.
 *
 * ## Why every reference on a page resolves in one request
 *
 * `ReferenceResolver` batches. Six links issuing six requests would resolve the
 * same corpus at six different moments, so a target republished mid-load would
 * render two different generations on one screen; one request is one snapshot. It
 * also bounds what opening a document costs the API.
 */
/**
 * The resolver a reference view should use, set by whichever component is about to
 * create an editor.
 *
 * A module global rather than an extension option because `addNodeView` is declared
 * inside the node type, and the node type is a module-level constant shared by
 * every editor on the page — a per-editor resolver has to be reached at view
 * construction time, not at node-definition time. There is one editor at a time (the
 * workbench shows one document), and `beginEditor` / `endEditor` scope it, so the
 * lifetime is explicit rather than incidental: opening a document builds a resolver,
 * closing it destroys that one, and a stale cache cannot outlive the document it
 * cached.
 */
let activeResolver: ReferenceResolver | null = null;

export function beginEditor(): ReferenceResolver {
  const resolver = new ReferenceResolver(defaultFetch);
  activeResolver = resolver;
  return resolver;
}

export function endEditor(resolver: ReferenceResolver): void {
  resolver.destroy();
  if (activeResolver === resolver) activeResolver = null;
}

export const DocReference = Node.create({
  name: 'docReference',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      /** Document id or slug. Slug is accepted so a hand-written link works. */
      document: { default: null },
      anchor: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-doc-ref]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-doc-ref': '' })];
  },

  addNodeView() {
    // Resolved at construction, not captured at definition: see activeResolver.
    return ({ node }) =>
      new ReferenceView(
        node.attrs as { document?: string; anchor?: string },
        // No editor open (a preview rendered outside the panel): fall back to a
        // throwaway resolver so a reference still resolves instead of throwing.
        activeResolver ?? new ReferenceResolver(defaultFetch),
      );
  },

  addCommands() {
    return {
      /** Insert a reference at the caret. The toolbar offers it; the slash menu can later. */
      setDocumentReference:
        (attrs: { document: string; anchor?: string }) =>
        ({ chain }) =>
          chain().insertContent({ type: this.name, attrs }).run(),
    };
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    docReference: {
      setDocumentReference: (attrs: { document: string; anchor?: string }) => ReturnType;
    };
  }
}

/**
 * Fetches and caches resolutions for one editor.
 *
 * The cache is per-instance and deliberately not reactive state: a NodeView polls
 * it when its resolution lands, and re-rendering the whole editor because one
 * label changed would throw away the caret position of everyone looking at it.
 */
export class ReferenceResolver {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly resolved = new Map<string, ResolvedHeadingDto>();
  private readonly subscribers = new Map<string, Set<(row: ResolvedHeadingDto | null) => void>>();

  constructor(private readonly fetch: (refs: string[]) => Promise<ResolvedHeadingDto[]>) {}

  /** `document#anchor`, the same token form the endpoint takes. */
  static token(document: string, anchor?: string | null): string {
    return anchor ? `${document}#${anchor}` : document;
  }

  private key(document: string, anchor?: string | null): string {
    return ReferenceResolver.token(document, anchor);
  }

  current(document: string, anchor?: string | null): ResolvedHeadingDto | null {
    return this.resolved.get(this.key(document, anchor)) ?? null;
  }

  subscribe(key: string, fn: (row: ResolvedHeadingDto | null) => void): () => void {
    const set = this.subscribers.get(key) ?? new Set();
    set.add(fn);
    this.subscribers.set(key, set);
    return () => set.delete(fn);
  }

  /**
   * Ask for a reference; resolves when an answer (or an admission of failure) is
   * available. Called from a NodeView's constructor, so it runs once per rendered
   * reference, which is why the queue dedupes by token.
   */
  load(document: string, anchor?: string | null): Promise<void> {
    const key = this.key(document, anchor);
    if (this.resolved.has(key)) return Promise.resolve();
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    if (!this.queue.includes(key)) this.queue.push(key);
    const run = this.flush().then(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, run);
    return run;
  }

  /**
   * Collect everything queued in the current tick into one request.
   *
   * `queueMicrotask` is not enough — the fetches are per-node and the nodes mount
   * across a Vue patch pass — so this rides a 0ms timer, the same trick the
   * backend's autosave uses for the opposite reason. A document with six references
   * then costs one round trip instead of six, and sees one consistent snapshot.
   */
  private flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    return new Promise((resolve) => {
      this.timer = setTimeout(() => {
        this.timer = null;
        const refs = this.queue.splice(0, this.queue.length);
        if (refs.length === 0) {
          resolve();
          return;
        }
        void this.fetch(refs)
          .then((rows) => {
            // Zip by the anchor field the server echoes rather than by index, so a
            // server that reorders or drops one cannot label the wrong link.
            const byToken = new Map<string, ResolvedHeadingDto>();
            for (const row of rows) byToken.set(ReferenceResolver.token(row.documentId, row.anchor), row);
            for (const ref of refs) {
              const row = byToken.get(ref);
              if (!row) continue;
              this.resolved.set(ref, row);
              for (const fn of this.subscribers.get(ref) ?? []) fn(row);
            }
          })
          .catch(() => {
            // A failed resolution leaves the views showing their own fallback. The
            // alternative — an error toast per link — would be noise, because a
            // reference to a document someone deleted is a content problem, not a
            // network one.
            for (const ref of refs) this.pending.delete(ref);
          })
          .finally(() => resolve());
      }, 0);
    });
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subscribers.clear();
    this.pending.clear();
  }
}

async function defaultFetch(refs: string[]): Promise<ResolvedHeadingDto[]> {
  const qs = refs.map((r) => `ref=${encodeURIComponent(r)}`).join('&');
  const body = await api<{ headings: ResolvedHeadingDto[] }>(`/headings/resolve?${qs}`);
  return body.headings;
}

/**
 * The DOM behind one reference.
 *
 * Shows the target's current heading text once known, and before that its anchor —
 * which is honest ("this points at `krok-1`, text not yet fetched") rather than
 * blank, and stays useful if the fetch never completes. When the target resolves as
 * inaccessible, the *anchor only* form is kept and the link is not made clickable:
 * the server withheld the title precisely so this client could not show it, and a
 * `…` placeholder is the truthful rendering of "there is something here".
 */
class ReferenceView {
  readonly dom: HTMLElement;
  private attrs: { document?: string; anchor?: string };
  private key: string;
  private unsubscribe: () => void;

  constructor(
    attrs: { document?: string; anchor?: string },
    private readonly resolver: ReferenceResolver,
  ) {
    this.attrs = attrs;
    this.dom = document.createElement('span');
    this.dom.className = 'doc-ref';
    this.dom.setAttribute('data-doc-ref', '');
    this.key = ReferenceResolver.token(attrs.document ?? '', attrs.anchor);
    this.render(this.resolver.current(attrs.document ?? '', attrs.anchor));
    this.unsubscribe = this.resolver.subscribe(this.key, (row) => this.render(row));
    if (attrs.document) void this.resolver.load(attrs.document, attrs.anchor);
  }

  private render(row: ResolvedHeadingDto | null): void {
    const anchor = this.attrs.anchor ?? '';
    if (!row) {
      this.dom.textContent = anchor ? `#${anchor}` : (this.attrs.document ?? '');
      this.dom.title = 'Načítám odkaz…';
      this.dom.setAttribute('data-resolved', 'loading');
      this.dom.removeAttribute('data-slug');
      return;
    }
    if (row.target === 'inaccessible') {
      // Anchor only. The server withheld the title precisely so that this client
      // could not show it; there is nothing to render and no link to follow.
      this.dom.textContent = anchor ? `#${anchor}` : '(skrytý dokument)';
      this.dom.title = 'Cíl nemáte oprávnění číst';
      this.dom.setAttribute('data-resolved', 'inaccessible');
      this.dom.removeAttribute('data-slug');
      return;
    }
    const label = row.text ?? (anchor ? `#${anchor}` : (row.title ?? ''));
    this.dom.textContent = row.title ? `${row.title} › ${label}` : label;
    this.dom.title = row.version ? `${row.title} — v${row.version}` : 'Zatím bez publikované verze';
    this.dom.setAttribute('data-resolved', row.text ? 'ok' : 'missing');
    if (row.slug) this.dom.setAttribute('data-slug', row.slug);
  }

  /**
   * ProseMirror calls this when the node is replaced by an equal-position node.
   *
   * Returning `true` always — even when nothing changed — is what the NodeView
   * contract asks for: the alternative is ProseMirror tearing down and rebuilding a
   * DOM element whose text is already correct, which flickers a "načítám" label in
   * front of every remote keystroke.
   */
  update(node: { attrs: Record<string, unknown> }): boolean {
    const next = node.attrs as { document?: string; anchor?: string };
    if (next.document === this.attrs.document && next.anchor === this.attrs.anchor) return true;
    this.unsubscribe();
    this.attrs = next;
    this.key = ReferenceResolver.token(next.document ?? '', next.anchor);
    this.unsubscribe = this.resolver.subscribe(this.key, (row) => this.render(row));
    if (next.document) void this.resolver.load(next.document, next.anchor);
    this.render(this.resolver.current(next.document ?? '', next.anchor));
    return true;
  }

  destroy(): void {
    this.unsubscribe();
  }
}
