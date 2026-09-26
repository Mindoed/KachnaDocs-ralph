# Phase 4 — Tasks and checklists

Ralph loop prompt for phase 4. Re-read this file every iteration; it may have been edited. Also read
ralph/PLAN.md and SPEC.md §4. Phases 1–3 gave you ACL, documents with drafts and versions, and a working
collaborative editing stack — reuse the realtime plumbing rather than inventing a second one.

## Iteration procedure

1. Read ralph/PLAN.md, this file, `ralph/FINDINGS.md`. Check `git log --oneline -15` and `git status`.
2. Pick the highest-priority unfinished item. Do it. Commit.
3. Run `npm run verify`. A red gate outranks new features.
4. Record progress and blockers in `ralph/FINDINGS.md`.

## Goal — SPEC.md §4

- Checklists with items: create, edit, reorder, delete, toggle done/undone.
- Assign an item to a user. Optional due date (a nullable column, and the UI must handle "no deadline").
- Repeat or reset a checklist's completion state.
- Completion state and percentage, last-editor and last-modified shown.
- Realtime sync between users — reuse the Yjs/y-websocket setup from phase 3, so checkbox changes propagate
  the same way document edits do.
- Create a checklist from a simple text format (one item per line; `- [ ]` prefixes honored). Document this
  format in the README of the module.
- Link a checklist to a document, and expose checklist items inside the editor's checklist nodes so the two
  representations stay consistent.
- Filter tasks by user, state, and due date (including overdue).
- Permissions inherit from the owning group or document — same `PermissionService`, SQL-level filtering.

Frontend: a tasks view listing assigned and open items, plus a checklist view for a single checklist, and
inline checklists in documents. Show progress clearly; a user should see at a glance what is done, what
remains, and who owns each item.

## Tests

- Toggle by user A appears for user B without reload (Playwright, two contexts).
- Ordering survives concurrent reorder attempts — decide and document the merge behavior, test it.
- Text-format import round-trip, including `- [ ]`, `- [x]`, and plain lines.
- Reset/repeat clears completion without losing items or assignments.
- Filtering by assignee, state, due date, and overdue.
- ACL: no `READ` means the checklist is invisible in API, list, and search — same 404 shape as nonexistent.

## Done when

`npm run verify` exits 0 and every function bullet in SPEC.md §4 is implemented or in `ralph/DEFERRED.md` with a
reason. Then, and only then, output exactly:

<promise>TASKS DONE</promise>

Never emit the promise to escape the loop. Three failed iterations on one item: log it, narrow it, continue
elsewhere.
