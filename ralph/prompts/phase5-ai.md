# Phase 5 — RAG chatbot

Ralph loop prompt for phase 5. Re-read this file every iteration; it may have been edited. Also read
ralph/PLAN.md (especially §2.1) and SPEC.md §5. Phases 1–4 gave you ACL, published document versions with heading
anchors, and checklists.

## Iteration procedure

1. Read ralph/PLAN.md, this file, `ralph/FINDINGS.md`. Check `git log --oneline -15` and `git status`.
2. Pick the highest-priority unfinished item. Do it. Commit.
3. Run `npm run verify`. A red gate outranks new features.
4. Record progress and blockers in `ralph/FINDINGS.md`.

## Goal — SPEC.md §5

Pipeline, in this order: authorization → retrieval over permitted content only → RAG assembly → generation →
answer with citations.

**Real:** chunking of published versions, the `embedding vector(...)` column, the HNSW index, similarity
search, and ACL filtering pushed into the SQL query so a forbidden chunk never leaves the database.
Embeddings come from `HashingEmbeddingProvider` — deterministic and offline, and intentionally weak; do not
claim retrieval quality from it.

**Stubbed:** `GenerationProvider` with a single `StubProvider` implementation returning a deterministic
Czech answer composed from retrieved chunks plus their citations. No network in tests. Adding a real model
later must mean one new class implementing the interface — say so in the module README.

- Chat with persisted message history per conversation, follow-up questions in scope.
- Citations on every answer, linking to the document and the specific heading anchor. Clicking a citation
  opens that part of the document in the UI.
- Behavior rules loaded from a configuration Markdown file, re-read on change; document the file's format.
- **Unanswerable questions:** when nothing relevant is retrieved, the answer must say the documentation does
  not cover it. Implement this as a retrieval score threshold, and test it — SPEC.md:133 is a requirement,
  not a aspiration.
- No indirect disclosure: the answer and its citations must never reveal the title, existence, or content of
  a document the actor cannot `READ` (ralph/PLAN.md §3). This is the phase's central security test.

Frontend: chat view in a sidebar, message list, streaming-looking output is fine, citation chips that open
the target document at its anchor.

## Tests

- ACL retrieval test: a forbidden document's chunks are excluded at the SQL level — assert via the query,
  and assert the chat answer never contains that document's title or content.
- Citation integrity: every citation resolves to a real anchor in a real published version.
- Below-threshold retrieval → admits it does not know, and cites nothing.
- Follow-up question reuses conversation context.
- Config Markdown change alters behavior (assert a rule that is observable, e.g. answer language or tone).
- Reindex: publishing a new version updates the chunks for that document.

## Done when

`npm run verify` exits 0 and every function bullet in SPEC.md §5 is implemented or in `ralph/DEFERRED.md` with a
reason. Then, and only then, output exactly:

<promise>AI DONE</promise>

Never emit the promise to escape the loop. Three failed iterations on one item: log it, narrow it, continue
elsewhere.
