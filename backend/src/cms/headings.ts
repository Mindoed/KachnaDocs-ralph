/**
 * Reading a ProseMirror document from the server side: its heading outline and
 * its Markdown projection.
 *
 * Both are needed by more than one caller now — publish snapshots them, the
 * realtime gateway writes the draft projection, and cross-document references
 * resolve against the outline — so they live here rather than inside whichever
 * controller asked for them first. A second definition of "what a heading is"
 * or "what Markdown looks like" would be free to disagree with the first, and
 * the disagreement would surface as anchors that resolve in one path and not
 * another.
 */

/** Loose shape of a ProseMirror node; untrusted input arrives as `unknown`. */
export interface PmNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: unknown;
  marks?: unknown[];
}

export interface FoundHeading {
  anchor: string;
  level: number;
  text: string;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Concatenated text of a subtree, marks and all. */
export function textOf(node: PmNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textOf).join('');
}

/**
 * Headings in document order.
 *
 * Anchors are read from the node's attrs — assigned once when the heading node
 * was created and never derived from its text (PLAN §2.4) — so publishing and
 * resolving preserve what the editor stamped. A heading with no anchor is a
 * draft written before the editor existed, or one seeded directly into the
 * database; it still gets an ordinal anchor so the outline stays addressable
 * rather than silently losing a row.
 */
export function walkHeadings(body: unknown): FoundHeading[] {
  const found: FoundHeading[] = [];
  const walk = (node: PmNode | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'heading') {
      const anchor = asString(node.attrs?.anchor);
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      found.push({ anchor: anchor || `h-${found.length + 1}`, level, text: textOf(node) });
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(body as PmNode);
  return found;
}

/** One leaf's text with its marks applied. */
function inlineOf(node: PmNode): string {
  const text = textOf(node);
  const kinds = new Set(
    (node.marks ?? [])
      .map((mark) =>
        mark && typeof mark === 'object' && 'type' in mark ? String((mark as { type: unknown }).type) : '',
      )
      .filter(Boolean),
  );
  // Order matters: `***x**y*` is not `**` plus `*` concatenated either way, so
  // bold wraps inside italic the way Tiptap nests the spans.
  let out = text;
  if (kinds.has('code')) out = out.length > 0 ? `\`${out}\`` : out;
  if (kinds.has('bold')) out = `**${out}**`;
  if (kinds.has('italic')) out = `*${out}*`;
  if (kinds.has('strike')) out = `~~${out}~~`;
  const href = (node.marks ?? []).find(
    (mark) =>
      mark && typeof mark === 'object' && 'type' in mark && (mark as { type: unknown }).type === 'link',
  ) as { attrs?: Record<string, unknown> } | undefined;
  const target = asString(href?.attrs?.href);
  if (target) out = `[${out}](${target})`;
  return out;
}

function inlineBlockOf(node: PmNode): string {
  return (node.content ?? []).map(inlineOf).join('');
}

/**
 * The Markdown projection of a ProseMirror body, stored beside it so diffs
 * (phase 2) and this phase's autosave have a text form to compare.
 *
 * A deliberate subset, not a general Markdown writer: headings, paragraphs, the
 * two list kinds with their checklists, code blocks, blockquotes, tables, images
 * and horizontal rules — which is the node set the editor registers. Anything
 * else contributes only its text, so an unexpected node degrades to prose rather
 * than throwing inside a websocket message handler, where a throw would drop the
 * connection and read as a networking bug.
 *
 * Known and recorded limitation: nested lists keep their text but not their
 * indentation. Nothing in the gate depends on a nested list round-tripping
 * through Markdown — the published snapshot stores the JSON, which does.
 */
export function renderMarkdown(body: unknown): string {
  const blocks = (body as PmNode | undefined)?.content ?? [];
  const out: string[] = [];

  for (const node of blocks) {
    switch (node.type) {
      case 'heading': {
        const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
        const anchor = asString(node.attrs?.anchor);
        // The anchor rides in the heading itself so a Markdown reader can link to
        // it and so the text form carries the same identity the JSON does.
        const suffix = anchor ? ` {data-anchor="${anchor}"}` : '';
        out.push(`${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${inlineBlockOf(node)}${suffix}`);
        break;
      }
      case 'paragraph':
        out.push(inlineBlockOf(node));
        break;
      case 'bulletList':
      case 'orderedList': {
        const ordered = node.type === 'orderedList';
        out.push(
          (node.content ?? [])
            .map((item, i) => `${ordered ? `${i + 1}.` : '-'} ${inlineBlockOf(item)}`)
            .join('\n'),
        );
        break;
      }
      case 'taskList':
        out.push(
          (node.content ?? [])
            .map((item) => {
              const checked = item.attrs?.checked === true;
              return `- [${checked ? 'x' : ' '}] ${inlineBlockOf(item)}`;
            })
            .join('\n'),
        );
        break;
      case 'codeBlock':
        out.push(['```', textOf(node), '```'].join('\n'));
        break;
      case 'blockquote': {
        const inner = renderMarkdown({ type: 'doc', content: node.content ?? [] });
        out.push(
          inner
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        );
        break;
      }
      case 'table':
        out.push(renderTable(node));
        break;
      case 'image': {
        const src = asString(node.attrs?.src);
        const alt = asString(node.attrs?.alt);
        out.push(src ? `![${alt}](${src})` : '');
        break;
      }
      case 'horizontalRule':
        out.push('---');
        break;
      default:
        // document, text and anything unrecognised: their text, so nothing is lost.
        out.push(inlineBlockOf(node));
        break;
    }
  }

  // Blank line between blocks, none after the last, no trailing newline: the seed
  // fixtures and the phase-2 diff assertions are written against exactly this.
  return out.filter((block) => block.length > 0).join('\n\n');
}

function renderTable(table: PmNode): string {
  const rows = (table.content ?? []).flatMap((row) =>
    row.type === 'tableRow' ? [row] : (row.content ?? []),
  );
  const cellsOf = (row: PmNode): string[] =>
    (row.content ?? []).map((cell) => inlineBlockOf(cell).replace(/\|/g, '\\|').replace(/\n+/g, ' '));
  const [header, ...rest] = rows;
  if (!header) return '';
  const head = cellsOf(header);
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const row of rest) lines.push(`| ${cellsOf(row).join(' | ')} |`);
  return lines.join('\n');
}

/**
 * What a live cross-document reference resolves to, once the SQL has decided
 * whether the caller may see the target at all (PLAN §2.5).
 *
 * `text` is the target's CURRENT published heading text, resolved per reader at
 * read time. It is never a copy taken when the reference was inserted, so
 * republishing the target changes every reference to it — which is the whole
 * point, and is what the phase-3 browser test watches happen.
 *
 * `inaccessible` is the placeholder PLAN §2.5 requires: the target's existence
 * and its title are both withheld, so a reference cannot be used to enumerate
 * documents the reader was not granted.
 */
export interface ResolvedReference {
  target: 'ok' | 'inaccessible';
  documentId: string;
  slug: string | null;
  title: string | null;
  anchor: string;
  level: number | null;
  text: string | null;
  version: number | null;
}

export const INACCESSIBLE_DOCUMENT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * A reference to a document the reader cannot READ.
 *
 * Carries a valid-but-meaningless UUID rather than the real document id or the
 * slug: awareness has no ACL of its own, this payload reaches every client
 * joined to the referring document, and PLAN §3.3 does not make an exception for
 * a value that arrived in a JSON field instead of a response body. The anchor
 * stays, because it is the referring document's own content — the reader already
 * has it — and keeping it preserves the link's shape without naming its target.
 */
export function inaccessibleReference(anchor: string): ResolvedReference {
  return {
    target: 'inaccessible',
    documentId: INACCESSIBLE_DOCUMENT_ID,
    slug: null,
    title: null,
    anchor,
    level: null,
    text: null,
    version: null,
  };
}

/** True for anything the inaccessible branch could have produced, and nothing else. */
export function isInaccessibleRefValue(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { documentId?: unknown }).documentId === INACCESSIBLE_DOCUMENT_ID
  );
}
