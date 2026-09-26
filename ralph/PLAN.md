# KachnaDocs — build plan

Operational plan for the Ralph loops that build [SPEC.md](../SPEC.md). SPEC.md is the source of truth for **what**;
this file is the source of truth for **how, in what order, and how it is checked**.

Read this file at the start of every loop iteration, along with the current phase file in `ralph/prompts/`.

---

## 1. Stack

| Concern | Choice |
|---|---|
| Language | TypeScript everywhere, strict mode |
| Backend | NestJS + Swagger (`/api/docs`) |
| Frontend | Vue 3 (`<script setup>`) + Vite + Pinia |
| Database | PostgreSQL 17 + pgvector, via `docker-compose.yml`, migrations with node-pg-migrate |
| Realtime | Yjs + y-websocket server, Tiptap for the document model |
| API tests | Jest + supertest, Bruno collection under `bruno/` for manual poking |
| Browser tests | Playwright, two browser contexts to test sync |
| Monorepo | npm workspaces: `backend/`, `frontend/`, `shared/` |

`shared/` holds the types and DTOs both sides use, so the frontend cannot drift from the API.

## 2. Decisions already made — do not reopen

These were chosen deliberately. If one turns out to be wrong, write the problem to `ralph/FINDINGS.md` and
work around it; do **not** silently change the architecture.

### 2.1 LLM is stubbed; retrieval is real

`GenerationProvider` is an interface. `StubProvider` is the only implementation in scope and returns a
deterministic answer composed from the retrieved chunks (quoted sentences + their citations, in Czech).

The **pgvector half is real**: real embeddings column, real HNSW index, real similarity search, real
ACL-filtered retrieval. Stubbing the LLM must not become stubbing the RAG. Embeddings in dev/test come from
`HashingEmbeddingProvider` (deterministic, offline, no API key) — deliberately a bad embedder, so nobody
mistakes a passing similarity test for embedding quality.

Swapping in a real model later means adding one class implementing `GenerationProvider`. Keep that true.

### 2.2 Identity is behind a provider interface

```
IdentityProvider (interface)
├── DevIdentityProvider     default in dev+test; seeds fixed users and fake roles, no network
└── DiscordOAuthProvider    active only when DISCORD_CLIENT_ID is set
```

Nothing may import the Discord SDK outside `discord-oauth.provider.ts`. The loop must never need Discord
credentials. `AUTH_DONE` does not require a working Discord login — it requires that swapping to the real
provider is a config change, documented in `docs/discord-oauth.md` with links (Discord developer docs,
OAuth2 scopes `identify` + `guilds`, redirect URI shape) and with `DiscordOAuthProvider` implemented and
unit-tested against a mocked HTTP layer.

### 2.3 Yjs owns the draft; versions are snapshots

This is the resolution of the draft-vs-immutable-version tension, and it matters:

- Yjs document state is persisted **only for the draft** (as Yjs updates, in `documents.y_state`).
- Publishing **materializes an immutable snapshot**: Tiptap ProseMirror JSON + rendered Markdown + heading
  anchors, stored in `document_versions`. Snapshots are never derived by replaying Yjs history.
- A version is therefore self-contained and renderable with no Yjs available. Diff and "restore as new
  draft" both read snapshots.
- Restoring an old version writes its content into the draft as a new Yjs transaction.

### 2.4 Heading anchors are stable and assigned once

Every heading gets `data-anchor` — a short nanoid created when the heading node is created, never derived
from its text. Renaming a heading must not change its anchor, and every heading in a published version
gets a row in `headings` so `/documents/:slug#anchor` resolves and cross-document references can be
validated.

### 2.5 Cross-document references are live, not copies

Embedding text from another document's heading (SPEC.md §2) renders the **current published content** of
that target at read time, resolved server-side. Never copy text into the referring document. A reference
to a target the reader cannot `READ` renders as an inaccessible placeholder — title withheld, per SPEC.md §5.

### 2.6 UI shell

VS Code / Obsidian-like: activity ribbon on the left, up to two sidebars plus a main area, each module a
"view" that can dock in either sidebar or the main area. Pinia store owns layout; no view hardcodes its
own dock position. Where each module docks is a reasonable judgement call, recorded in `ralph/FINDINGS.md`.

## 3. Security invariants

SPEC.md §3 says authorization is enforced in the backend and hiding UI is not security. Concretely, these
are the properties the test suite must demonstrate, and they are **not** negotiable:

1. `PermissionService` is the only thing that decides access. Every controller goes through it.
2. Every read path applies ACL at the **SQL level**, not by filtering rows in TypeScript: document content,
   fulltext search, Yjs websocket join, and AI retrieval all take the actor and filter in the query.
3. A user without `READ` cannot learn a document exists — not via API, search, websocket, or AI answer.
   The response for "no READ" and "does not exist" is identical (404), so existence is not a side channel.
4. Permission resolution: explicit document grant > inherited group grant > deny. Discord roles and users
   are both subjects; a document may be owned by a Discord role.
5. Frontend hides affordances it lacks permission for, purely as UX. Tests assert the API denies even when
   the UI would have hidden it.

## 4. Verify gate

`npm run verify` is the only definition of done. Every loop iteration ends by running it; nothing counts as
complete that `verify` does not check.

```
npm run verify
  1. docker compose up -d db          # postgres+pgvector, dedicated test database
  2. npm run migrate && npm run seed  # idempotent seed, dev identities + fixtures
  3. npm run lint
  4. npm run typecheck                # both workspaces
  5. npm run test                     # jest unit + supertest e2e
  6. npm run test:e2e                 # playwright, realtime specs only
```

Rules for the gate:

- Exit nonzero on any failure. Never weaken an assertion to get green. Never commit a `.skip`.
- Frontend correctness outside the realtime specs is `typecheck` + `vite build` + human review. That is
  accepted, not a gap to fix mid-loop.
- Playwright is scoped to realtime behavior (two-context Yjs sync, remote cursors, publish→reader refresh,
  checklist live update) because that is precisely what cannot be verified any other way.

## 5. Phases

Each phase is its own Ralph loop with its own promise. Prompt bodies: `ralph/prompts/`.

| # | Phase | Promise | Max it. |
|---|---|---|---|
| 0+1 | Scaffold + verify gate, then auth & ACL | `AUTH DONE` | 25 |
| 2 | CMS with versioning | `CMS DONE` | 30 |
| 3 | Collaborative editor | `EDITOR DONE` | 35 |
| 4 | Tasks & checklists | `TASKS DONE` | 20 |
| 5 | RAG chatbot | `AI DONE` | 25 |

Order rationale: ACL precedes everything because every later phase must call it, and retrofitting
SQL-level filtering into four finished modules is the expensive path. Editor follows CMS because it needs
the draft/published model. Tasks need both documents and ACL. AI is last because retrieval is only
interesting once there is versioned, permission-scoped content to retrieve from.

## 6. Loop guardrails

- Commit after each meaningful unit of work, on `master`, with a message naming the phase.
- Append to `ralph/FINDINGS.md` (create it) whenever blocked, when a decision in §2 hurts, or when a design
  question arises that SPEC.md does not answer. Include iteration number. Do not delete past entries.
- Never edit `.claude/ralph-loop.local.md`. Never run `git push`.
- Never mark a phase done because it "looks finished". The promise for the phase may be emitted only when
  `npm run verify` exits 0 **and** every function bullet in that phase's SPEC.md section is either
  implemented or explicitly listed in `ralph/DEFERRED.md` with a reason.
- If the same failure resists three consecutive iterations, stop retrying it: write it to `ralph/FINDINGS.md`,
  narrow the scope, and continue elsewhere in the phase.
