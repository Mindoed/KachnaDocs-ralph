# Deferred

Function bullets from SPEC.md that a phase did **not** implement, with the reason. A phase's completion
promise may be emitted while items are listed here — but not while items are silently missing.

Format: `phase — SPEC.md bullet — reason`

---

## Phase 1 (auth + ACL)

- **1 — SPEC.md:92 "…nesmí získat obsah přes vyhledávání, WebSocket ani AI chatbot"** — those three
  surfaces do not exist yet. The API path is asserted (`backend/test/acl.e2e-spec.ts`). What phase 1
  actually delivers for this bullet is the _means_: `accessible_documents`/`accessible_groups` as SQL
  functions, so each later surface filters in its own query instead of re-deciding. Each of phases 2–5
  must prove the denial over its own transport; the ACL layer cannot do it on their behalf.
- **1 — `NONE` is not selectable in the grant editor** — `GrantEditor.vue` offers READ/WRITE/MANAGE
  only. `NONE` is a _deny override_ (SPEC.md:82), not a fourth rung on the ladder, and offering it in a
  dropdown labelled "permission" would read as "less than READ" rather than "explicitly denied,
  overriding inheritance". It belongs with the per-document override UI in phase 2, where the inherited
  grant it overrides is visible next to it. The API and the SQL accept `NONE` today and the ACL tests
  assert it is honored.
- **1 — role membership is not guild-scoped** — `fetchRoleMembership` reads `/guilds/{id}/roles`, which
  yields role _definitions_ the app can see, not the roles a specific member holds; correct behavior
  needs a bot token and `guilds.members.read` (`/guilds/{id}/members/{me}`). `docs/discord-oauth.md` §4
  documents the exact change. Deliberate: the ACL stores `discord_roles.id` and does not care what
  produced the membership, so this is a provider-local fix. Not exercised by any test, because no test
  talks to Discord.
- **1 — session is a JWT in `localStorage`, not an httpOnly cookie** — enables the token to survive the
  SPA-only frontend without CSRF machinery, at the cost of no server-side revocation (logout clears
  client state; the token stays valid until TTL). Cookie sessions + CSRF belong to deployment hardening.
  The OAuth handoff already uses the URL _fragment_ rather than a query string for this reason.
- **1 — `GET /permissions/effective?userId=` only checks "manages anything"** — a coarse
  yes-anywhere check, not "manages _that user_". Acceptable while there is one admin view and every
  returned grant is the caller's own or manageable; must be revisited when phase 2 adds user browsing.
- **1 — no logout/revocation endpoint, no refresh tokens** — nothing to revoke without a session table;
  Discord refresh tokens are unused and the session simply expires at `JWT_TTL_SECONDS` (12 h).

## Phase 2 (CMS + versioning)

- **2 — categories are not an ACL target** — SPEC.md §1 lists categories as part of the documentation
  hierarchy, and `categories.group_id` makes them visible exactly where their group is. A grant directly
  _on a category_ is not implementable: `permissions` targets only groups and documents, and the SQL
  resolvers (`accessible_groups`/`accessible_documents`) would need a third inheritance path. Deliberate —
  one resolution path is the phase-1 invariant (PLAN.md §3.1), and nothing in SPEC.md asks for per-category
  grants. Revisit only if a real requirement appears.
- **2 — no `y_state` column yet** — PLAN.md §2.3 has Yjs owning the draft, stored in `documents.y_state`.
  Phase 2 stores `draft_body` (ProseMirror JSON) + `draft_markdown` instead, because the collaborative
  server arrives in phase 3. Publish reads from the same columns phase 3 will populate, so the snapshot
  path does not change when Yjs lands — only the writer does.
- **2 — SPEC.md §1 "Očekávané chování": "Publikování … informuje ostatní klienty o změně"** — **closed by
  phase 3**, on a different mechanism than assumed here, which is worth recording because the difference is
  the reason the shipped design is not a broadcast. Phase 2 expected "the publish handler gains one
  broadcast" over phase 3's websocket. What actually happens: `GET /documents/:id/realtime-status` carries
  `publishedVersion`, the editor polls it every 2 s, and a reader who sees it advance rebuilds their editor
  session (`EditorSession.vue` emits `republished`; `EditorPanel.vue` folds a nonce into the session `:key`).
  Two things the broadcast assumption got wrong, both proven in `e2e/realtime.spec.ts`:
  1. Pushing the new version into a connected reader's Y.Doc — which is what a broadcast means — _merges_
     it beside the old one rather than replacing it. Yjs item ids are `(clientID, clock)` pairs assigned at
     creation, so a second version's items are new content by construction and CRDT-merge cleanly next to
     the first version's: heading twice, both bodies. The reader's document has to be *destroyed and
     rebuilt*, which no server-side push can do for a client.
  2. The rebuild is gated to `READ`. A writer's Y.Doc holds unsaved draft work by definition; replacing it
     on a publish would discard whatever they typed since the last autosave. Writers learn about a publish
     through the history panel they are holding (phase 2's pull path, unchanged).
  Polling rather than a push on the websocket is the remaining compromise, and it is small: the notification
  path reuses the endpoint the autosave indicator already polls, so a publish costs no new message type and
  no new state on the room. A reader notices within 2 s instead of immediately.
- **2 — the CMS tree renders Markdown, not styled ProseMirror output** — `VersionHistoryPanel` shows a
  snapshot's `markdown` in a `<pre>` plus its heading outline. Rendering the ProseMirror JSON is the
  editor's job (phase 3 owns Tiptap); a second, cheaper formatter here would mean two definitions of what a
  document looks like, free to disagree.
- **2 — group and category CRUD has no UI** — SPEC.md §1 asks the CMS view to create, rename, move, archive
  and delete _documents_, which the tree does. Groups and categories are managed through the API
  (`/groups`, `/categories`, covered by `cms-crud.e2e-spec.ts`) and the seed fixture. A tree read-only above
  the document level is a real limitation of this phase's UI, recorded rather than left implied.

---

## Phase 5 (RAG + AI asistent)

- **5 — SPEC §5 "chování konfigurovatelné v Markdown souboru": prose rules are parsed, not obeyed** —
  `behavior-config.service.ts` splits the file into `key: value` settings and prose. The settings are
  executed by the pipeline today (retrieval threshold, citation count, non-answer wording, answer prefix),
  which is what makes "editing the config changed the behaviour" a test that passes today. The prose is
  concatenated and handed to `GenerationInput.behaviorRules`, where **a real model would consume it as a
  system prompt** — `StubProvider` quotes retrieved chunk text verbatim and cannot follow an instruction,
  by design (see the header comment in `generation.provider.ts`: it does not write prose, does not invent
  an answer, and does not decide what may be retrieved). So a rule like "Odpovídej střídmě" is
  round-tripped and ignored until a model is bound. Deliberate rather than missing: pretending to obey
  prose would make the config file's effect a matter of opinion, and the phase's testable claim is about
  the settings half. `AI_BEHAVIOR_FILE` is re-read on change (stat signature includes the path), so the
  moment a model lands the prose is already delivered to it.
- **5 — no fulltext search endpoint exists, so SPEC.md:90's "…přes API, vyhledávání, WebSocket ani AI
  chatbot" is asserted on three of four surfaces** — verified by grep: no `to_tsquery`/`tsvector` anywhere
  in `backend/migrations` or `backend/src`. SPEC.md:4 lists "fulltextové vyhledávání" as a product feature
  and PLAN.md §3.1 names "fulltext search" as one of the four read paths that must filter in SQL, but
  **no `ralph/prompts/*.md` assigns it to any phase** — the bullet is carried by phase 1's deferral of the
  same sentence and has not since been picked up. `ai_search_chunks`
  (migration 1740000009000) is vector retrieval, not fulltext, and is asserted per-candidate through
  `can_access_document`. This is the one item here that is a gap between documents rather than a phase's
  scope choice, and it should be scheduled explicitly rather than inherited again.
- **5 — a malformed conversation id answers 500, not the 404 PLAN §3.3 requires** —
  `GET /ai/conversations/:id` with a non-UUID path parameter raises a database error rather than the
  "does not exist" answer a valid-but-someone-else's id gets. PLAN §3.3 wants denial and absence
  indistinguishable, and a 500 is distinguishable, though it discloses nothing (no row data, and the
  status is not conditioned on any grant). Left unfixed and **not asserted into permanence**: the honest
  fix is input validation returning 400 before the query, which is a product decision about the error
  contract rather than an ACL change, and writing the current behaviour as a test would be asserting the
  defect. `backend/test/ai.e2e-spec.ts` therefore uses `GHOST_ID` — a valid UUID that really does get the
  404 — for the indistinguishability claim.
