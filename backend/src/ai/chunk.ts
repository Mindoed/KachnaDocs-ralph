/**
 * Splitting a published version into retrievable chunks.
 *
 * The unit is *the section*, not the paragraph or a fixed token window: SPEC §5
 * requires every citation to link to "dokument nebo konkrétní nadpis", and a
 * chunk that straddles two headings can only cite one of them honestly. So the
 * document is walked in order, a heading opens a section, and everything up to
 * the next heading belongs to it. A section longer than `maxChars` is split into
 * consecutive pieces at block boundaries — retrieval wants pieces small enough
 * that one answer isn't mostly padding — and every piece keeps the heading it
 * came from, so every citation still names the heading the reader should land on.
 *
 * Chunk 0 is special-cased: content before the first heading gets the document's
 * own title as its heading and the first anchor it contains (or a synthetic one),
 * because a document that opens with a preamble is still retrievable and still
 * has to cite something real. `headings` rows are per-version and the anchor must
 * resolve, so the fallback anchor is the same `h-N` ordinal form `walkHeadings`
 * already assigns to anchorless headings (PLAN §2.4) rather than a second idea of
 * what an anchor is.
 *
 * Deterministic by construction: same body in, same chunks out, same order.
 * That is what lets a reindex be asserted against chunk *content* rather than
 * merely against "some rows exist".
 */

import { textOf, walkHeadings, type FoundHeading, type PmNode } from '../cms/headings';

export interface Chunk {
  ord: number;
  /**
   * The heading this chunk sits under, or null when it precedes the first one
   * in a document that has no headings at all.
   *
   * Null is not a gap to fill with a synthetic anchor. SPEC §5 asks a source to
   * link "přímo na dokument **nebo** konkrétní nadpis" — a document-level link is
   * the sanctioned fallback, whereas inventing an anchor the publish never wrote
   * to `headings` would produce a citation that resolves nowhere, which is the
   * exact failure the citation-integrity test is for.
   */
  anchor: string | null;
  heading: string;
  text: string;
}

export interface ChunkOptions {
  /** Target upper bound per chunk. Splitting only happens at block boundaries. */
  maxChars?: number;
  /**
   * Blocks shorter than this are merged with their neighbour. Without it a
   * one-line section becomes a chunk whose text is smaller than its own
   * citation, and a document of many short sections retrieves its table of
   * contents instead of its content.
   */
  minChars?: number;
}

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_MIN_CHARS = 80;

/**
 * A section as a list of block texts, flattened to plain prose.
 *
 * Markdown syntax is deliberately not preserved: `renderMarkdown` exists for
 * diffs and for the version snapshot, and feeding it to the embedder would make
 * `**` and `|` carry weight in a similarity score. Tables are the exception
 * worth keeping legible — their cells are the content — so a table contributes
 * its cells joined by ` · ` rather than pipe-delimited Markdown.
 */
function blockText(node: PmNode): string {
  if (node.type === 'table') {
    const rows = (node.content ?? []).flatMap((row) =>
      row.type === 'tableRow' ? [row] : (row.content ?? []),
    );
    return rows
      .map((row) =>
        (row.content ?? [])
          .map((cell) => textOf(cell).replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' · '),
      )
      .filter(Boolean)
      .join('\n');
  }
  if (node.type === 'image') {
    const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
    return alt ? `[obrázek: ${alt}]` : '';
  }
  return textOf(node).replace(/\s+/g, ' ').trim();
}

interface Section {
  anchor: string | null;
  heading: string;
  blocks: string[];
}

/**
 * Each heading *node* mapped to the outline entry `walkHeadings` produced for it.
 *
 * A pre-order walk identical to `walkHeadings`'s, keyed by object identity, so a
 * section's anchor is the same anchor the publish wrote into `headings` — not a
 * re-derivation that can disagree. The disagreement this prevents is the
 * citation-integrity failure the prompt asks to be tested: a chunk citing an
 * anchor the version has no row for. Nested headings (inside a blockquote) are
 * mapped too, which is why keying by node beats counting.
 */
function anchorByNode(body: unknown): Map<PmNode, FoundHeading> {
  const outline = walkHeadings(body);
  const map = new Map<PmNode, FoundHeading>();
  let cursor = 0;
  const walk = (node: PmNode | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'heading') {
      const entry = outline[cursor];
      cursor += 1;
      if (entry) map.set(node, entry);
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(body as PmNode);
  return map;
}

/** Blocks grouped by the top-level heading they fall under. */
function sectionsOf(body: unknown, title: string): Section[] {
  const anchors = anchorByNode(body);
  const doc = body as PmNode | undefined;
  // Content before the first heading is not under any heading, so it cites the
  // document (anchor null) and names the document's title as its heading.
  const preamble: Section = { anchor: null, heading: title, blocks: [] };
  const sections = [preamble];
  let current = preamble;

  for (const node of doc?.content ?? []) {
    if (node.type === 'heading') {
      const entry = anchors.get(node);
      current = {
        anchor: entry?.anchor ?? `h-${sections.length}`,
        heading: entry?.text ?? title,
        blocks: [],
      };
      sections.push(current);
      // The heading's own text leads its section: a chunk that omits its title
      // retrieves worse than one that repeats it, and the reader landing on the
      // anchor should find text similar to what matched.
      const own = blockText(node);
      if (own) current.blocks.push(own);
      continue;
    }
    const text = blockText(node);
    if (text) current.blocks.push(text);
  }
  return sections;
}

/** Group blocks into pieces of at most `maxChars`, merging runt pieces. */
function piecesOf(blocks: string[], maxChars: number, minChars: number): string[] {
  const pieces: string[] = [];
  let buffer = '';
  for (const block of blocks) {
    if (!block) continue;
    // A single block over the cap stays whole rather than being cut mid-word:
    // a chunk boundary in the middle of a sentence produces a citation the
    // reader cannot use, and a long block is rarer than a long section.
    if (buffer.length > 0 && buffer.length + block.length + 1 > maxChars) {
      pieces.push(buffer);
      buffer = block;
    } else {
      buffer = buffer.length > 0 ? `${buffer} ${block}` : block;
    }
  }
  if (buffer.length > 0) pieces.push(buffer);

  if (pieces.length < 2) return pieces;
  // Fold a runt leading piece into the next one. Only the head needs this: a
  // short tail already has a neighbour to its left and is a real short section.
  if (pieces[0].length < minChars) {
    const [head, next, ...rest] = pieces;
    return [`${head} ${next}`, ...rest];
  }
  return pieces;
}

/**
 * The chunks of one published version, in document order with dense `ord`.
 */
export function chunkVersion(body: unknown, title: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  const sections = sectionsOf(body, title);
  const chunks: Chunk[] = [];
  for (const section of sections) {
    for (const text of piecesOf(section.blocks, maxChars, minChars)) {
      if (!text.trim()) continue;
      chunks.push({ ord: chunks.length, anchor: section.anchor, heading: section.heading, text });
    }
  }
  return chunks;
}
