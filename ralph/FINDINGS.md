# Findings

Running log written by the Ralph loops. Append entries; never rewrite or delete past ones.

Each entry: iteration number, phase, what was learned / what blocked progress / which decision in ralph/PLAN.md §2
turned out to hurt. Design questions that SPEC.md does not answer belong here too.

---

## it.3-6 — phase 1, scaffold + SQL ACL

- Docker Desktop was not running; started it. `scripts/wait-db.mjs` now guards the gate against a cold container.
- `npm install` hit Windows `ENOTEMPTY` on a stale partial `node_modules`; resolved by removing
  `node_modules` + `package-lock.json` and reinstalling. Expect this again after dependency changes.
- **All permission resolution lives in Postgres** (migration 1740000002000): `permission_rank`,
  `actor_subjects`, `group_grants_for`, `document_grants_for`, `accessible_documents`, `accessible_groups`,
  `can_access_document`, `can_access_group`. Verified by hand in psql: role inheritance, group hierarchy
  expansion, document-level override, default deny, and source labels all behave. Later phases filter with
  these instead of re-implementing checks.
- **Added `NONE` to `permission_kind`** (PLAN.md §2 did not anticipate it). SPEC.md:82 requires overriding an
  inherited grant at document level; with only positive grants an "override" can only ever widen access, so
  the requirement is inexpressible. `NONE` is an explicit deny that wins over any granting path. `shared`
  splits `Permission` (what a route may require) from `GrantKind` (what may be stored) so no endpoint can
  ever *require* NONE.
- Migration gotchas found the hard way: `pgm.createEnum()` returns a statement, not a type name (use
  `pgm.createType` + a string type); backticks inside a `pgm.sql` template literal terminate the JS string
  (use `$$`-quoted SQL body, no backticks in comments).
- `accessible_groups` returns `SETOF uuid`, so its result column is named after the function; callers must
  alias it (`ag(grp)`).

## Open / next

- NestJS app wiring, controllers, seed, jest+supertest ACL suite, frontend shell, Playwright wiring.
- Phase 1 will not finish inside 10 iterations. Remaining: e2e ACL tests, `docs/discord-oauth.md`,
  permissions admin view.

## it.5-7 — backend boots; two real defects found by running it

Seed now self-verifies (11 ACL expectations asserted in `verifyFixture()`); it
exists because a mis-numbered `$n` placeholder silently built a nonsense
permission graph — cheaper to assert than to eyeball SQL.

Bugs found only by booting the API and curling it, neither visible to tsc:

1. `user_discord_roles` had **no primary key** — node-pg-migrate's
   `primaryKey: { columns: [...] }` table option emitted no constraint, so
   repeated role syncs duplicated membership rows and `/auth/me` listed the same
   Discord role twice. Fixed in migration 1740000003000 (dedupe + real PK).
   **Do not trust that option; check constraints after migrating.**
2. `effectiveForUser` called `group_grants_for($1, 'READ')` — two args to a
   one-arg SQL function, added when the permission floor moved into each caller.
   500 via `/permissions/effective`. The SQL layer was fine; the call site was
   stale. Also made the source label prefer a direct grant over an inherited one
   of equal rank.

Verified working: dev login, `/auth/me`, `/permissions/effective` (Payroll
reported as `role-inherited` via HR; `salaries` correctly absent for Ana, so the
NONE override holds through the HTTP layer), anonymous request -> 401.

## Phase 1 status — NOT complete

Done: scaffold, compose+pgvector, SQL ACL (8 functions), identity providers,
PermissionService, guard, permissions controller, seed + self-verification, API
boots. Backend typechecks clean.

Outstanding, all of it required before `AUTH DONE`: jest+supertest ACL suite,
`docs/discord-oauth.md`, frontend shell + permissions view, Playwright wiring,
eslint/prettier configs (root `lint` script currently has no config file),
Swagger. `npm run verify` fails.

Note: `.env` was created from `.env.example` for manual testing; gitignored.
