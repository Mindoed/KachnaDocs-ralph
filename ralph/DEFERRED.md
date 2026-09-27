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
- **2 — SPEC.md §1 "Očekávané chování": "Publikování … informuje ostatní klienty o změně"** — publishing
  creates the version row (asserted) but pushes nothing to other clients, because there is no transport to
  push over: the y-websocket server is phase 3, and PLAN.md §4 puts "publish→reader refresh" inside
  Playwright's realtime scope for exactly that reason. Phase 2 ships the pull path — the history panel
  refetches after a publish, and a reader's next request sees the new head. When the websocket lands, the
  publish handler gains one broadcast; neither the snapshot nor the ACL path changes. This is the one
  SPEC.md §1 bullet phase 2 does not satisfy, and the one it cannot satisfy without phase 3's infrastructure.
- **2 — the CMS tree renders Markdown, not styled ProseMirror output** — `VersionHistoryPanel` shows a
  snapshot's `markdown` in a `<pre>` plus its heading outline. Rendering the ProseMirror JSON is the
  editor's job (phase 3 owns Tiptap); a second, cheaper formatter here would mean two definitions of what a
  document looks like, free to disagree.
- **2 — group and category CRUD has no UI** — SPEC.md §1 asks the CMS view to create, rename, move, archive
  and delete _documents_, which the tree does. Groups and categories are managed through the API
  (`/groups`, `/categories`, covered by `cms-crud.e2e-spec.ts`) and the seed fixture. A tree read-only above
  the document level is a real limitation of this phase's UI, recorded rather than left implied.
