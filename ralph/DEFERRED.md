# Deferred

Function bullets from SPEC.md that a phase did **not** implement, with the reason. A phase's completion
promise may be emitted while items are listed here — but not while items are silently missing.

Format: `phase — SPEC.md bullet — reason`

---

## Phase 1 (auth + ACL)

- **1 — SPEC.md:92 "…nesmí získat obsah přes vyhledávání, WebSocket ani AI chatbot"** — those three
  surfaces do not exist yet. The API path is asserted (`backend/test/acl.e2e-spec.ts`). What phase 1
  actually delivers for this bullet is the *means*: `accessible_documents`/`accessible_groups` as SQL
  functions, so each later surface filters in its own query instead of re-deciding. Each of phases 2–5
  must prove the denial over its own transport; the ACL layer cannot do it on their behalf.
- **1 — `NONE` is not selectable in the grant editor** — `GrantEditor.vue` offers READ/WRITE/MANAGE
  only. `NONE` is a *deny override* (SPEC.md:82), not a fourth rung on the ladder, and offering it in a
  dropdown labelled "permission" would read as "less than READ" rather than "explicitly denied,
  overriding inheritance". It belongs with the per-document override UI in phase 2, where the inherited
  grant it overrides is visible next to it. The API and the SQL accept `NONE` today and the ACL tests
  assert it is honored.
- **1 — role membership is not guild-scoped** — `fetchRoleMembership` reads `/guilds/{id}/roles`, which
  yields role *definitions* the app can see, not the roles a specific member holds; correct behavior
  needs a bot token and `guilds.members.read` (`/guilds/{id}/members/{me}`). `docs/discord-oauth.md` §4
  documents the exact change. Deliberate: the ACL stores `discord_roles.id` and does not care what
  produced the membership, so this is a provider-local fix. Not exercised by any test, because no test
  talks to Discord.
- **1 — session is a JWT in `localStorage`, not an httpOnly cookie** — enables the token to survive the
  SPA-only frontend without CSRF machinery, at the cost of no server-side revocation (logout clears
  client state; the token stays valid until TTL). Cookie sessions + CSRF belong to deployment hardening.
  The OAuth handoff already uses the URL *fragment* rather than a query string for this reason.
- **1 — `GET /permissions/effective?userId=` only checks "manages anything"** — a coarse
  yes-anywhere check, not "manages *that user*". Acceptable while there is one admin view and every
  returned grant is the caller's own or manageable; must be revisited when phase 2 adds user browsing.
- **1 — no logout/revocation endpoint, no refresh tokens** — nothing to revoke without a session table;
  Discord refresh tokens are unused and the session simply expires at `JWT_TTL_SECONDS` (12 h).

