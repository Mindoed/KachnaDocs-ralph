import * as Y from 'yjs';
import { Extension, getSchema } from '@tiptap/core';
// @tiptap/core re-exports the ProseMirror model classes at runtime but not their
// types, so `Schema` has to come from the package that actually defines it.
import type { Schema } from '@tiptap/pm/model';
import { StarterKit } from '@tiptap/starter-kit';
import { Image } from '@tiptap/extension-image';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import {
  prosemirrorJSONToYDoc,
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} from '@tiptap/y-tiptap';
import { RT_FRAGMENT } from '@kachnadocs/shared';

/**
 * The draft as a Yjs document: seeding it, projecting it back, and the schema
 * seeding needs.
 *
 * The asymmetry in that sentence is the design. Reading a Y.Doc — PM JSON out,
 * Markdown out — walks the Y.XmlFragment and needs no schema at all, so the
 * gateway can project a draft on every keystroke without ever instantiating an
 * editor. Only the one-time conversion of an existing `draft_body` into a Y.Doc
 * needs `Node.fromJSON`, and therefore a schema. That is the sole reason this
 * file has one, and it is why the schema is asserted rather than assumed:
 *
 * `Node.fromJSON` DROPS any attribute the schema does not declare. Verified: a
 * heading carrying `attrs.anchor` comes back with only `level` when the schema
 * is the plain StarterKit set. So a server-side schema that drifts from the
 * frontend's loses anchors, and it loses them quietly — no error, just a
 * published version whose headings cannot be linked to. PLAN §2.4 says anchors are
 * assigned once and must survive, so `anchorSurvivesTheSchema()` is the guard and
 * `draft-document.test.ts` runs it. If the two schemas ever diverge on a node
 * type, that test says so in a sentence instead of a browser test failing three
 * layers away.
 *
 * What this file is NOT: a second editor configuration. It registers no keymaps,
 * no input rules, no commands, no marks beyond those the content nodes carry. If
 * phase 5's editor gains a node type, adding it here matters only if documents
 * can contain it — seeding content of an unknown type is where this schema has to
 * know, and projecting it does not.
 */

/**
 * Headings carry a stable anchor, assigned once at node creation and never
 * derived from text (PLAN §2.4). Declared here as a global attribute so every
 * heading node gets it, exactly as the editor's own extension does.
 */
const AnchorHeading = Extension.create({
  name: 'anchorHeading',
  addGlobalAttributes: () => [
    {
      types: ['heading'],
      attributes: {
        anchor: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-anchor'),
          renderHTML: (attributes) =>
            typeof attributes['anchor'] === 'string' ? { 'data-anchor': attributes['anchor'] } : {},
        },
      },
    },
  ],
});

// Link ships inside StarterKit 3, so it is deliberately not registered again —
// a second extension of the same name does not fail, it warns and lets whichever
// registered last win the config, which is the kind of thing that reads as
// "links randomly stopped working".
const SCHEMA_EXTENSIONS = [
  StarterKit,
  AnchorHeading,
  Image,
  Table,
  TableRow,
  TableCell,
  TableHeader,
  TaskList,
  TaskItem,
];

let schema: Schema | null = null;

/** Built once; a ProseMirror schema is immutable and expensive to rebuild. */
export function draftSchema(): Schema {
  if (!schema) schema = getSchema(SCHEMA_EXTENSIONS);
  return schema;
}

/**
 * Turn an existing `draft_body` into the Y.Doc the editor binds to.
 *
 * Only ever called for a document that has no `y_state` yet — the first time
 * anyone opens it in the editor after this migration. The comment in y-tiptap is
 * explicit that rehydrating through this path discards history, and it is right:
 * calling it again on a document that already has state would hand every client a
 * fresh document and orphan everyone still connected. The caller guards that with
 * `y_state IS NULL` inside the same transaction that writes the result, so two
 * simultaneous first-opens cannot both seed.
 */
export function seedYDocFromPmJson(body: unknown, clientID?: number): Y.Doc {
  if (clientID === undefined) return prosemirrorJSONToYDoc(draftSchema(), body, RT_FRAGMENT);
  // A deterministic client id makes the *resulting Yjs items* deterministic, because
  // item ids are (clientID, clock) pairs assigned at creation — setting it afterwards
  // is too late, so this has to seed into a fragment the caller's doc owns rather than
  // letting `prosemirrorJSONToYDoc` build the doc itself.
  //
  // Used only for a reader's per-connection snapshot; the draft path must keep its
  // random id, since two writers seeding the same `draft_body` must not collide.
  const ydoc = new Y.Doc();
  ydoc.clientID = clientID;
  prosemirrorJSONToYXmlFragment(draftSchema(), body, ydoc.getXmlFragment(RT_FRAGMENT));
  return ydoc;
}

/**
 * A stable 32-bit id for one published version of one document.
 *
 * A reader's snapshot is rebuilt from the newest published version on *every*
 * connection, and a ticket rotates about once a minute — so the same version is
 * served into the same client Y.Doc repeatedly. With a random id each time, the
 * second serving is indistinguishable from genuinely new content and the merge
 * keeps both copies: the reader's document grows a second heading and a second
 * paragraph, once a minute, forever. Derived from the document and the version
 * number, an unchanged version produces byte-identical items and re-applying it is
 * a no-op; a new publish changes the id, and the new items merge in beside the old
 * ones — which is the correct outcome, since the previous version's content really
 * has been replaced.
 *
 * FNV-1a rather than a counter or a hash module: it is five lines, collision
 * resistance is irrelevant here (a collision means two versions share item ids, and
 * the worst case is that a reader sees one version where they should have seen the
 * other — never a cross-document leak, since item ids are namespaced by the
 * fragment they live in), and the input is two ids we already have.
 */
export function snapshotClientId(documentId: string, version: number): number {
  let hash = 0x811c9dc5;
  const input = `${documentId}@${version}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The draft as ProseMirror JSON. No schema: the fragment carries type names. */
export function pmJsonFromYDoc(ydoc: Y.Doc): Record<string, unknown> {
  return yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(RT_FRAGMENT));
}

/**
 * Load stored bytes into a fresh Y.Doc.
 *
 * Tolerates a corrupt or truncated blob by returning an empty doc rather than
 * throwing: the alternative is that one bad row makes a document permanently
 * unopenable, and the error would surface as a websocket disconnect. An empty doc
 * is recoverable — the published version is still readable, and a writer's next
 * autosave writes valid state.
 */
export function loadYDoc(state: Uint8Array | null): Y.Doc {
  const ydoc = new Y.Doc();
  if (!state) return ydoc;
  try {
    Y.applyUpdate(ydoc, state);
  } catch {
    return new Y.Doc();
  }
  return ydoc;
}

/** Current state as a full update, ready for `y_state`. */
export function encodeYDoc(ydoc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(ydoc);
}

/**
 * True when `pmJsonFromYDoc` against this schema would keep heading anchors.
 *
 * Not a runtime check — a self-test, exercised by the unit suite, that asks the
 * real schema the question whose wrong answer is silent data loss.
 */
export function anchorSurvivesTheSchema(): boolean {
  const probe: unknown = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1, anchor: 'anchor-probe' },
        content: [{ type: 'text', text: 'test' }],
      },
    ],
  };
  const round = yXmlFragmentToProsemirrorJSON(seedYDocFromPmJson(probe).getXmlFragment(RT_FRAGMENT));
  const first = (round['content'] as Array<{ attrs?: Record<string, unknown> }> | undefined)?.[0];
  return first?.['attrs']?.['anchor'] === 'anchor-probe';
}
