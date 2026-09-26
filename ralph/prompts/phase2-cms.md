# Phase 2 — CMS with versioning

Ralph loop prompt for phase 2. Re-read this file every iteration; it may have been edited. Also read
ralph/PLAN.md and SPEC.md §1. Start by reading `git log` and `ralph/FINDINGS.md` to see where phase 1 left off.

## Iteration procedure

1. Read ralph/PLAN.md, this file, `ralph/FINDINGS.md`. Check `git log --oneline -15` and `git status`.
2. Pick the highest-priority unfinished item. Do it. Commit.
3. Run `npm run verify`. A red gate outranks new features.
4. Record progress and blockers in `ralph/FINDINGS.md`.

## Goal — SPEC.md §1

Data model: groups (hierarchical), categories, documents. Each document has a working **draft** and zero or
more immutable published **versions**.

- CRUD for groups, categories, documents: create, rename, move (reparent/reorder), archive, delete.
- Document state: `Draft` / `Published` / `Archived`, surfaced in the UI.
- Publish creates an immutable snapshot per ralph/PLAN.md §2.3 — ProseMirror JSON + rendered Markdown + heading
  anchors. Never reconstruct a version by replaying Yjs updates.
- Version history: author, timestamp, optional comment. Open any older version. Diff an older version
  against the current one. Restore an older version **as a new draft** (never in place).
- Readers without `WRITE` see only the published version. A draft must never leak through a read-only path.
- Every route goes through `PermissionService` with SQL-level filtering (ralph/PLAN.md §3). Reuse the phase-1
  helper; do not write ad-hoc permission checks.

Frontend: the CMS view — documentation tree, keyboard-friendly selection, context actions for rename/move/
archive/delete, state badge, version history panel, version diff viewer. Dock it per ralph/PLAN.md §2.6 and note
the choice in `ralph/FINDINGS.md`.

## Tests

- Publish → new version row, draft unchanged, immutable (an update attempt on a version fails).
- Reader sees published content while an editor's concurrent draft edits are invisible to them.
- Diff and restore round-trip: restore v1 as draft, publish, verify content equals v1 and history has a new
  head.
- ACL: unauthorized actor cannot read, edit, publish, or manage — and cannot distinguish "no permission"
  from "does not exist".
- Move/reparent preserves descendants and their inherited permissions.

## Done when

`npm run verify` exits 0 and every function bullet in SPEC.md §1 is implemented or in `ralph/DEFERRED.md` with a
reason. Then, and only then, output exactly:

<promise>CMS DONE</promise>

Never emit the promise to escape the loop. If an item resists 3 iterations, log it in `ralph/FINDINGS.md` and work
elsewhere in the phase.
