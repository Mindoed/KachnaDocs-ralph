# Phase 3 — Collaborative editor

Ralph loop prompt for phase 3. Re-read this file every iteration; it may have been edited. Also read
ralph/PLAN.md and SPEC.md §2. Phase 2 gave you documents, drafts, and published versions — build on them, and
keep phase 1's ACL on every path.

## Iteration procedure

1. Read ralph/PLAN.md, this file, `ralph/FINDINGS.md`. Check `git log --oneline -15` and `git status`.
2. Pick the highest-priority unfinished item. Do it. Commit.
3. Run `npm run verify`. A red gate outranks new features.
4. Record progress and blockers in `ralph/FINDINGS.md`.

## Goal — SPEC.md §2

Tiptap (ProseMirror) bound to Yjs, with a y-websocket server, editing the **draft** only.

- Nodes: headings, paragraphs, lists, links, tables, images, code, checklists.
- Awareness: presence list of connected collaborators, remote cursors and selections.
- Autosave with visible `Ukládání… / Uloženo` state; persistence of Yjs state per ralph/PLAN.md §2.3.
- Heading anchors: `data-anchor` assigned once at node creation, never text-derived (ralph/PLAN.md §2.4). Anchor
  copy UI on each heading. Published versions get `headings` rows so `#anchor` deep links resolve.
- Internal links between documents, and cross-document heading references resolved live at read time
  (ralph/PLAN.md §2.5) — never a copied snapshot of the target's text.
- Edit / preview toggle. `READ` renders read-only, `WRITE` enables editing; the websocket join is
  permission-checked server-side, not merely in the client.
- Concurrent edits must not clobber each other — that is what Yjs gives you, so make sure the Yjs doc is
  genuinely shared per document rather than reloaded from the server on every reconnect.

## Tests — Playwright earns its keep here

Playwright specs with **two browser contexts** are the point of this phase; SPEC.md:64 ("bez obnovení
stránky") is not checkable any other way.

- User A types, user B sees it without reload.
- Simultaneous edits in different paragraphs both survive, and neither cursor is lost.
- A `READ`-only user's websocket join to a write channel is rejected by the server (assert the server, not
  the disabled toolbar).
- Remote cursor/selection renders for the other context.
- Anchor deep link opens the right heading in the right document.
- Cross-document reference shows updated target content after the target is republished.
- Draft/publish boundary: live edits do not change the published version until publish.

Jest unit tests for the Yjs<->ProseMirror binding edge cases you can drive headlessly.

## Done when

`npm run verify` exits 0 and every function bullet in SPEC.md §2 is implemented or in `ralph/DEFERRED.md` with a
reason. Then, and only then, output exactly:

<promise>EDITOR DONE</promise>

Never emit the promise to escape the loop. If an item resists 3 iterations, log it in `ralph/FINDINGS.md` and work
on another item in the phase — realtime plumbing is the part most likely to need a fresh approach.
