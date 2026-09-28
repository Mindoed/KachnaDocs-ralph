import { Extension } from '@tiptap/core';
import { UniqueID } from '@tiptap/extension-unique-id';
import { newHeadingAnchor } from '@kachnadocs/shared';

/**
 * Headings carry a stable anchor (PLAN §2.4).
 *
 * Two extensions, because the two jobs are genuinely separate and Tiptap ships
 * them separately: `AnchorAttribute` says a heading *has* an `anchor` attribute
 * and how it crosses into and out of the DOM, and `anchorIds()` says where its
 * value comes from. Merging them would mean hand-writing the thing
 * `@tiptap/extension-unique-id` already does correctly — it fills null attributes
 * in an `appendTransaction`, marks that transaction `addToHistory: false`, and
 * handles the cases a hand-rolled walk gets wrong, like a heading produced by
 * splitting another heading or by pasting a fragment.
 *
 * **Assigned once, never derived from text.** UniqueID generates a value only when
 * the attribute is null, and nothing here ever clears it, so renaming a heading
 * keeps its anchor. That is the whole requirement: an anchor tracking its heading's
 * text would break every published URL the moment someone fixed a typo, which is
 * precisely what §2.4 forbids.
 *
 * **Rendered as `data-anchor`.** A ProseMirror attribute reaches the DOM only if
 * something renders it, and this name is the one the backend's Markdown renderer
 * emits (`# Title {data-anchor="x"}`) and `parseHTML` reads back. Round-tripping
 * under one name is what makes an anchor created in the browser byte-identical to
 * the one a published snapshot re-imports — a mismatch would not throw, it would
 * quietly hand a re-imported heading a brand-new anchor and break its deep links.
 *
 * **Existing content is stamped on first load.** Every document in the database
 * predates the editor, so its headings have `anchor: null`. UniqueID fills those
 * the first time the document loads, which is why nothing else in the tree needs to
 * know: without it, phase 2's seeded documents would fall back to the ordinal
 * anchors in `cms/headings.ts` (`h-1`, `h-2`), and inserting a heading at the top
 * of a document would silently renumber every deep link below it.
 *
 * **`filterTransaction` is the collaborative half.** A heading created by someone
 * else arrives as a remote transaction that *already* carries their anchor; without
 * this, this client would look at the same null-became-value race from the other
 * side and stamp its own. Skipping remote transactions leaves one generator per
 * heading — the local one — which is what stops two people opening the same
 * anchor-less document simultaneously from each inventing an anchor for it.
 */
export const AnchorAttribute = Extension.create({
  name: 'anchorAttribute',

  addGlobalAttributes() {
    return [
      {
        types: ['heading'],
        attributes: {
          anchor: {
            // null means "not assigned yet", which is what UniqueID looks for.
            default: null,
            parseHTML: (element) => element.getAttribute('data-anchor'),
            renderHTML: (attributes) =>
              typeof attributes['anchor'] === 'string' ? { 'data-anchor': attributes['anchor'] } : {},
          },
        },
      },
    ];
  },
});

/**
 * The generator, configured against the attribute above.
 *
 * `types: ['heading']` and not `'all'`: an id on every node would rewrite every
 * paragraph in every legacy document on first open, which is a large Yjs
 * transaction for something only headings need, and it would put identity on nodes
 * whose identity nothing references.
 *
 * `updateDocument: false` on a read-only render — a reader must not mutate a
 * document by looking at it, and `setEditable(false)` alone does not stop an
 * appendTransaction.
 */
export function anchorIds(options: { enabled?: boolean } = {}): Extension {
  return UniqueID.configure({
    attributeName: 'anchor',
    types: ['heading'],
    // Shared with the backend's seed path so an imported document gets the same
    // shape of anchor as a typed one.
    generateID: () => newHeadingAnchor(),
    filterTransaction: (transaction) => !isRemoteChange(transaction),
    updateDocument: options.enabled ?? true,
  });
}

/**
 * Did this transaction come from another client?
 *
 * The y-tiptap sync plugin tags its own transactions on the `y-sync$` meta key;
 * reading it is the documented way to tell "I typed this" from "this arrived over
 * the websocket". Everything else (local typing, undo, paste) counts as local,
 * which is the safe direction to be wrong in: a missed remote transaction means a
 * heading gets an anchor from the client that created it, which is correct anyway.
 */
function isRemoteChange(transaction: { getMeta: (key: string) => unknown }): boolean {
  const meta = transaction.getMeta('y-sync$');
  return (
    typeof meta === 'object' &&
    meta !== null &&
    (meta as { isChangeOrigin?: boolean }).isChangeOrigin === true
  );
}
