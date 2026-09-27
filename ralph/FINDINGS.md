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

## Phase 1 — COMPLETE (`npm run verify` → exit 0)

Gate: 5 unit + 27 jest-over-real-HTTP + 9 Playwright, plus lint/typecheck/build across all three
workspaces.

Things that surfaced only by running the gate, never from `tsc`:

1. **pgvector was never installed.** `/api/health` reports `extversion` from `pg_extension` and the
   health e2e asserts it is non-null — which failed on first run. The image ships the extension but
   does not create it, and extensions are per-database, so migration 1740000004000 creates it and runs
   against both DBs. The user asked for pgvector in phase 1 precisely so this would not be discovered
   in phase 5; the assertion is what made "initialized" mean something rather than "a dependency we
   happen to be running".
2. **`DISCORD_REDIRECT_URI` was wrong in both `.env.example` and `env.ts`** — missing the `/api`
   prefix that `setGlobalPrefix` adds. Undetectable without a real Discord app (the failure is at
   Discord's consent redirect, outside this repo), so it is now commented at both sites and pinned by a
   unit test on `buildAuthorizeUrl()`.
3. **Two Playwright assertions were written against guesses about the fixture, and both were wrong**
   (expected 1 grant for Ana, actual 3; expected 2 explicit grants for Bona, actual 4). Queried
   `accessible_*` in psql for the real numbers instead of loosening the assertions — and the corrected
   version is stronger, because Ana's three rows cover the `role` and `role-inherited` sources on one
   screen. *Write assertions from the fixture, not from the fixture as imagined.*
4. **Jest hung after a green run** — the pg pool kept sockets open; `closePool()` in `stopServer()`.
   A gate that passes and then times out is a gate that fails randomly, which is worse than red.

Decisions worth carrying forward:

- **`test` and `test:e2e` were the same command.** Now split (`--testPathIgnorePatterns` /
  `--testMatch`); "run the unit tests" no longer boots Nest and Postgres.
- **Playwright's webServer is `node scripts/serve-e2e.mjs`**, which migrates + seeds the test DB then
  runs the API on :3100 with `NODE_ENV=test`. A node launcher rather than `FOO=bar npm start`, because
  npm scripts run under cmd.exe on Windows where inline env assignment is a different language. It
  spawns ts-node's bin directly because npm on Windows resolves through a `.cmd` whose shell wrapper
  Playwright's SIGTERM orphans — the leftover held the port and the next run died on EADDRINUSE.
- **The API serves `frontend/dist` when it exists** (`bootstrap.ts`), so the browser suite and any
  single-process deploy get one origin: no CORS, no Vite proxy pointed at a port nobody owns.
- **`/permissions/subjects` and `/permissions/targets`** added so SPEC.md:88 ("vyhledej a přidej práva")
  could be met without free-text UUID inputs. Both require managing *something*, so administering one
  document does not hand over a directory of the whole organisation.
- **Discord callback now 302s to `FRONTEND_ORIGIN#token=…`** instead of returning JSON (which no
  browser flow can consume); the SPA strips the fragment with `history.replaceState`. Fragment rather
  than query: never sent to servers, absent from `Referer`, absent from proxy logs.
- **`NONE` stays out of the grant UI** on purpose — DEFERRED.md.

Scope line for the browser suite, so it does not sprawl: it owns real-browser concerns (bundle boots,
session survives reload, docking persists, grant round-trip, SPA fallback). ACL *decisions* stay in
jest, which covers the same code far faster. The grant test revokes what it grants, which is what lets
it share the seeded fixture instead of needing an isolated database.

## it.1 (this loop) — phase 1 verification pass; SPEC.md:95 was unenforced

Re-ran `npm run verify` from a clean tree rather than trusting the "COMPLETE" entry
above. It passed (exit 0) as claimed, so the *gate* was honest. Auditing the §3
bullets against the code anyway turned up one that the gate did not actually cover:

- **SPEC.md:95 ("preferovat vázat vlastníky dokumentu jako discord roli") was data
  without behavior.** `documents.owner_role_id` existed in the schema and the seed
  populated it, but nothing read it — no query selected it, no DTO carried it, no
  assertion mentioned it. A later phase adding document writes could have moved
  ownership to per-user owners and the suite would have stayed green, which is the
  shape of gap a green gate is most dangerous for.
- Fix: `GET /documents` and `GET /documents/:id` now return `ownerRole`
  (`LEFT JOIN discord_roles`), and `acl.e2e-spec.ts` asserts `hr-handbook` is
  owned by the `HR` role and that *every* document the caller can see has a
  non-null owner. 28 jest-over-HTTP tests now (was 27).
- **Deliberate non-change: the ACL still does not read `owner_role_id`.** Ownership
  is provenance, not an access path. Making owners implicitly get MANAGE would put
  a second, un-`PermissionService` decision point into the system, violating
  PLAN.md §3.1; SPEC.md:95 constrains *what owners are bound to*, not what owners
  may do.
- Also verified rather than assumed: `docs/discord-oauth.md` exists; the grant
  editor really does offer `discord_role` subjects (SPEC.md:88), so the "users and
  Discord roles" bullet is met on the write path, not just the schema.

## it.1 (loop 2) — cancelled by user; fan-out audit attempt + one hardening fix

- Four parallel audit subagents (test vacuity, SPEC §3 coverage, gate honesty, invariant
  attacks) were launched per the user's request and all four wedged with no output after
  ~50 min. They were cancelled and the audit was done inline instead.
- Inline audit found and fixed one real weakness: `POST /permissions` branched on
  `subjectKind === 'user' ? users : discord_roles` with no validation, so any unrecognized
  value (`'role'`, `'User'`) silently became a **Discord role** grant — an ACL decision made
  by typo. Same for `targetKind`. Both are now validated against their legal values, with
  two e2e tests pinning it (30 jest-over-HTTP now, was 28).
- Checked and found sound: every read path is ACL-prefixed in SQL (`documentsFilter` has one
  caller, offset arithmetic correct); grant create/revoke both require MANAGE on the exact
  target, so managing one document cannot escalate; denial is 404-shaped everywhere.
- **Noted, not changed:** `RequirePermissionGuard` fails open when a handler has no
  `@RequirePermission` decorator (require-permission.guard.ts:51). Intentional today (health,
  login are public) and the comment says so, but phases 2-5 add many routes and omission
  then reads as "public by accident". A route-listing test or a default-deny guard would be
  cheap insurance before phase 2.
- `npm run verify` exits 0 (5 unit + 30 over-HTTP + 9 Playwright).
