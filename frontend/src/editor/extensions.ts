import { Extension } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table';
import { TableHeader } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import { yCursorPlugin } from '@tiptap/y-tiptap';
import type { Awareness } from 'y-protocols/awareness';
import type { Plugin } from '@tiptap/pm/state';
import type { Extensions } from '@tiptap/core';
import * as Y from 'yjs';
import { RT_FRAGMENT, type AwarenessUser } from '@kachnadocs/shared';
import { AnchorAttribute, anchorIds } from './anchorExtension';
import { DocReference } from './references';

/**
 * The document nodes, the CRDT binding, and the remote carets (SPEC.md §2).
 *
 * ## The fragment name is a wire format
 *
 * `field: RT_FRAGMENT` must match the backend's `draft-document.ts`, which projects
 * `ydoc.getXmlFragment(RT_FRAGMENT)` into `draft_body` and `draft_markdown`. Bind
 * the editor to a different name and nothing fails loudly: the browser edits an
 * empty fragment while the projector reads a stale one, so the editor shows your
 * keystrokes, the autosave reports "Uloženo", and the database never changes. It is
 * imported rather than restated for that reason.
 *
 * ## StarterKit's history is removed, not configured
 *
 * ProseMirror's undo stack undoes *positions*, and in a collaborative document that
 * means reverting somebody else's typing that happened to land after yours. The
 * Collaboration extension brings `yUndoPlugin`, which undoes only your own
 * contributions, because Yjs knows which client wrote each range. Two undo histories
 * in one editor is a bug that presents as "my colleague's paragraph disappeared when
 * I pressed Ctrl+Z" — so `undoRedo` is excluded here and the Tiptap `undo()`/`redo()`
 * commands come from Collaboration instead.
 *
 * `UniqueID`'s anchor backfill is likewise excluded from nothing here, but note that
 * `anchorIds()` is what brings it: StarterKit 3 does not include it.
 */
export function editorExtensions(options: {
  ydoc: Y.Doc;
  awareness: Awareness;
  /** A `READ` connection renders and does not generate (PLAN §2.4, §3). */
  canEdit: boolean;
}): Extensions {
  return [
    StarterKit.configure({
      // The key is `undoRedo`, not `history` — StarterKit 3 renamed it when
      // UndoRedo became its own extension, and the Collaboration extension warns at
      // runtime if both are present.
      undoRedo: false,
      heading: { levels: [1, 2, 3, 4] },
      // Code blocks and headings both survive into the published Markdown, so
      // nothing here needs a companion change on the backend to be lossless.
      codeBlock: { HTMLAttributes: { class: 'code-block' } },
    }),
    Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } }),
    Image,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table,
    TableRow,
    TableHeader,
    TableCell,
    Placeholder.configure({ placeholder: 'Pište…' }),
    AnchorAttribute,
    anchorIds({ enabled: options.canEdit }),
    DocReference,
    // Deliberately no `provider` and no `tokenRefresh`: this version of the
    // extension only reads `options.provider` to decide whether to log a
    // "y-provider found" notice, and never calls `tokenRefresh` at all (its
    // default is a no-op). The connection is entirely `useRealtime`'s business —
    // passing a provider here would suggest the extension owns it, and it does not.
    Collaboration.configure({ document: options.ydoc, field: RT_FRAGMENT }),
    RemoteCaret(options.awareness),
  ];
}

/**
 * Remote carets and selections.
 *
 * `yCursorPlugin` is both halves at once: it publishes the local selection under
 * the awareness `cursor` field and renders everyone else's. Wrapping it as an
 * Extension is how it enters the editor's plugin list — it is a ProseMirror plugin
 * factory, not a Tiptap extension.
 *
 * It renders from the awareness record's `user` field, which is why `useRealtime`
 * publishes one and why the server overwrites it on the way out: the label on a
 * caret comes from the credential the server verified, never from what the sending
 * client chose to call itself.
 *
 * `displayName` rather than `name` — and that is not a style preference. The
 * server's outbound rewrite installs `AwarenessUser`, whose field is `displayName`;
 * the plugin's *default* builder reads `name` and falls back to `User: 41932` when
 * it is missing. A builder that read `name` would therefore print a Yjs client
 * number where a colleague's name belongs, on every remote caret, in every
 * document — and because the fallback is deliberate and silent, nothing would warn.
 */
function RemoteCaret(awareness: Awareness): Extension {
  return Extension.create({
    name: 'remoteCaret',
    addProseMirrorPlugins(): Plugin[] {
      return [
        yCursorPlugin(awareness, {
          cursorBuilder: (raw: unknown) => {
            const user = (raw ?? {}) as Partial<AwarenessUser> & { name?: string };
            const name = user.displayName ?? user.name ?? '';
            const caret = document.createElement('span');
            caret.className = 'remote-caret';
            caret.setAttribute('data-testid', 'remote-caret');
            caret.setAttribute('data-user', name);
            caret.style.setProperty('--caret', user.color ?? '#ffa500');
            const label = document.createElement('span');
            label.className = 'remote-caret-label';
            label.textContent = name;
            caret.append(label);
            return caret;
          },
          // The builder returns the decoration's attributes directly — `class` and
          // inline styles as a flat map, matching the library's own default — not
          // wrapped in `{ attrs }`, which ProseMirror would try to read as a string
          // attribute and drop.
          selectionBuilder: (raw: unknown) => ({
            style: `background-color: ${colorOf(raw)}70`,
            class: 'remote-selection',
          }),
        }) as Plugin,
      ];
    },
  });
}

function colorOf(raw: unknown): string {
  const user = (raw ?? {}) as Partial<AwarenessUser>;
  return user.color ?? '#ffa500';
}
