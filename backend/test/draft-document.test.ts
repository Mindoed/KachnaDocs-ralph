import { describe, expect, it } from '@jest/globals';
import { getSchema } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { RT_FRAGMENT } from '@kachnadocs/shared';
import {
  anchorSurvivesTheSchema,
  draftSchema,
  encodeYDoc,
  loadYDoc,
  pmJsonFromYDoc,
  seedYDocFromPmJson,
} from '../src/rt/draft-document';
import { renderMarkdown, walkHeadings } from '../src/cms/headings';

/**
 * The Yjs<->ProseMirror boundary the realtime gateway sits on (ralph/PLAN.md §2.3).
 *
 * Everything here is pure data, which is why it is a unit test and not a browser
 * test: a browser would add cursors and input rules but tell me nothing new about
 * how content crosses between a Y.Doc and a JSON body.
 */

const heading = (text: string, anchor: string | null, level = 1): unknown => ({
  type: 'heading',
  attrs: anchor ? { level, anchor } : { level },
  content: [{ type: 'text', text }],
});

describe('the server-side draft schema', () => {
  it('registers every node type the editor can put in a document', () => {
    const nodes = Object.keys(draftSchema().nodes);
    // SPEC.md §2's node list plus the containers those need. A missing type is not
    // a crash — Node.fromJSON drops the node and its subtree — so a table would
    // silently vanish from a document the first time it is seeded.
    for (const type of [
      'doc',
      'paragraph',
      'heading',
      'text',
      'bulletList',
      'orderedList',
      'listItem',
      'taskList',
      'taskItem',
      'codeBlock',
      'blockquote',
      'image',
      'table',
      'tableRow',
      'tableCell',
      'tableHeader',
      'horizontalRule',
      'hardBreak',
    ]) {
      expect(nodes).toContain(type);
    }
  });

  it('keeps a heading anchor through seeding, which the plain set does not', () => {
    // The reason this schema is asserted rather than assumed. Found by hand:
    // getSchema([StarterKit]) alone describes a heading with attrs {level}, so
    // Node.fromJSON discards `anchor` without complaint and the published version
    // ends up with headings nothing can link to (PLAN §2.4).
    expect(anchorSurvivesTheSchema()).toBe(true);

    const naive = getSchema([StarterKit]);
    const body = { type: 'doc', content: [heading('Obsah', 'keep-me')] };
    const dropped = yXmlFragmentToProsemirrorJSON(
      prosemirrorJSONToYDoc(naive, body, RT_FRAGMENT).getXmlFragment(RT_FRAGMENT),
    );
    // Asserted rather than merely noted: if a future Tiptap ever preserved
    // undeclared attributes, this fails and the guard above becomes redundant
    // rather than quietly meaningless.
    expect(dropped.content[0]?.attrs?.['anchor']).toBeUndefined();
  });

  it('round-trips the fixture shapes without losing text or anchors', () => {
    const body = {
      type: 'doc',
      content: [
        heading('Obsah', 'sec-1'),
        { type: 'paragraph', content: [{ type: 'text', text: 'Základní pravidla.' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'jedna' }] }],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'úkol' }] }],
            },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'npm run verify' }] },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'sloupec' }] }],
                },
              ],
            },
          ],
        },
      ],
    };

    const out = pmJsonFromYDoc(seedYDocFromPmJson(body));
    expect(walkHeadings(out)).toEqual([{ anchor: 'sec-1', level: 1, text: 'Obsah' }]);
    const text = JSON.stringify(out);
    for (const fragment of ['Základní pravidla.', 'jedna', 'úkol', 'npm run verify', 'sloupec']) {
      expect(text).toContain(fragment);
    }
  });

  it('survives a corrupt stored state as an empty document rather than a throw', () => {
    // A throw here surfaces to a user as "the websocket keeps closing", which is
    // indistinguishable from a network fault, and would leave the document
    // permanently unopenable.
    const junk = new Uint8Array([0xff, 0xff, 0x00, 0x41, 0x00]);
    expect(pmJsonFromYDoc(loadYDoc(junk))).toBeTruthy();
    expect(pmJsonFromYDoc(loadYDoc(null))).toBeTruthy();
  });

  it('persists and reloads through encodeStateAsUpdate without drift', () => {
    // PLAN §2.3 stores Yjs *updates*, so whatever the gateway writes has to be
    // readable by the next process that loads it. Going through the real byte
    // representation is the only way to know structure is not being lost.
    const seeded = seedYDocFromPmJson({ type: 'doc', content: [heading('Obsah', 'sec-1')] });
    const bytes = encodeYDoc(seeded);
    expect(bytes.length).toBeGreaterThan(0);
    expect(pmJsonFromYDoc(loadYDoc(bytes))).toEqual(pmJsonFromYDoc(seeded));
  });

  it('needs no second Link extension, because StarterKit already provides it', () => {
    // Adding @tiptap/extension-link alongside StarterKit 3 does not fail — it
    // warns about a duplicate name and lets the later registration win, which is
    // worse than an error because "links behave oddly" is not a symptom that
    // points at it. Pinned so that oddity is a failed assertion, not a mystery.
    expect(Object.keys(getSchema([StarterKit]).marks)).toContain('link');

    const doubled = getSchema([StarterKit, Link]);
    expect(Object.keys(doubled.marks).sort()).toEqual(Object.keys(getSchema([StarterKit]).marks).sort());
  });
});

/**
 * The projection the gateway writes on each autosave and that publish reads.
 * Tested alongside the seeding above because the two are only correct together:
 * seeding produces the JSON and this turns it back into the text form the version
 * table stores.
 */
describe('the Markdown projection', () => {
  it('renders the shapes the editor produces', () => {
    const body = {
      type: 'doc',
      content: [
        heading('Obsah', 'sec-1'),
        heading('Podkapitola', null, 2),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'obyčejný ' },
            { type: 'text', text: 'tučně', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' a ' },
            { type: 'text', text: 'kód', marks: [{ type: 'code' }] },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'odkaz',
              marks: [{ type: 'link', attrs: { href: 'https://example.invalid/x' } }],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hotovo' }] }],
            },
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'neděláno' }] }],
            },
          ],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
                },
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }],
                },
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a|b' }] }],
                },
              ],
            },
          ],
        },
      ],
    };

    const md = renderMarkdown(body);
    // The anchor rides in the heading so the text form carries the same identity
    // as the JSON, in the shape the phase-2 seed fixtures already use.
    expect(md).toContain('# Obsah {data-anchor="sec-1"}');
    expect(md).toContain('## Podkapitola');
    expect(md).toContain('**tučně**');
    expect(md).toContain('`kód`');
    expect(md).toContain('[odkaz](https://example.invalid/x)');
    expect(md).toContain('- [x] hotovo');
    expect(md).toContain('- [ ] neděláno');
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    // An unescaped pipe in a cell renders as an extra column. That is phase 4's
    // checklist export path, so it is pinned now rather than discovered there.
    expect(md).toContain('a\\|b');
  });

  it('carries a phase-2 document through seed -> project -> render unchanged', () => {
    // The path a seeded document takes on its first autosave: JSON in the
    // database, seeded to Yjs, projected back, rendered. If the anchor dropped or
    // the text mangled anywhere in that chain, the draft the editor shows would
    // differ from the draft the user wrote, and the next diff would report a
    // change nobody made.
    const body = {
      type: 'doc',
      content: [
        heading('Obsah', 'sec-1'),
        { type: 'paragraph', content: [{ type: 'text', text: 'Tabulky ohodnocení.' }] },
      ],
    };
    const projected = pmJsonFromYDoc(seedYDocFromPmJson(body));
    expect(renderMarkdown(projected)).toBe('# Obsah {data-anchor="sec-1"}\n\nTabulky ohodnocení.');
  });

  it('degrades to text for a node it does not know instead of throwing', () => {
    // renderMarkdown runs inside the websocket update handler, where a throw drops
    // the connection and reads as an outage. An unknown node may cost at most its
    // formatting.
    const md = renderMarkdown({
      type: 'doc',
      content: [{ type: 'mermaidDiagram', content: [{ type: 'text', text: 'graph TD' }] }],
    });
    expect(md).toContain('graph TD');
  });

  it('renders an empty document as empty rather than as a stray newline', () => {
    expect(renderMarkdown({ type: 'doc', content: [] })).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(walkHeadings(null)).toEqual([]);
  });
});
