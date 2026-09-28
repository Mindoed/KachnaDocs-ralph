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

# Phase 2 — CMS with versioning

## it.1 — default-deny guard, before the route count grows

Phase 1 left `RequirePermissionGuard` returning `true` for any handler without
`@RequirePermission`. With eight routes that was a review-time concern; phase 2
adds CRUD for groups, categories, documents and versions, at which point "forgot
the decorator" and "meant to be public" become indistinguishable — the exact
shape of bug the phase-1 ACL tests exist to make impossible.

- Guard now denies by default. `@Public()` is what makes a route anonymous;
  `@RequirePermission(...)` is unchanged. Forgetting `@RequirePermission` still
  only skips the *grant* check (a signed-in caller gets through), but forgetting
  `@Public()` now fails closed with 401. Making the grant check itself mandatory
  would need an explicit `@AuthenticatedOnly()` on routes like `GET /auth/me` —
  deliberately left for when phase 2's write routes exist and can be listed.
- `@Public()` added to: `/health`, `POST /auth/dev-login`,
  `GET /auth/discord/authorize-url`, `GET /auth/discord/callback`.
- **This closed a real hole, not a hypothetical one**: `GET /documents` has no
  decorator (it filters in SQL instead), so under the old guard an anonymous
  request reached the handler and dereferenced `me.id` on an undefined user —
  a 500 where 401 was correct. Now unreachable.
- New e2e test asserts both halves: protected routes answer 401 to an anonymous
  caller, and `/health` is still 200. 31 over-HTTP tests (was 30). Frontend
  verified unaffected: `auth.ts restore()` already treats any `/auth/me` failure
  as "not signed in".

## it.1 — CMS schema: categories, drafts, immutable versions, headings

Migration 1740000005000_cms. Verified in psql, not just by typecheck:
3 version rows (one per Published doc), the immutability trigger rejecting
`UPDATE document_versions`, the category linked to a document, all four docs
carrying a draft body.

- **Version immutability is a database trigger, not a convention.** PLAN.md 2.3
  makes snapshots self-contained and permanent; a test asserting "an update
  attempt on a version fails" is only durable if the *database* refuses, because
  the test helpers can and do run raw SQL. BEFORE UPDATE and BEFORE DELETE
  both raise `check_violation`.
- **Categories are not an ACL target.** They hang off a group and are visible
  exactly where that group is, so `accessible_groups`/`accessible_documents`
  stay the only resolution paths. Adding a third target kind would mean a third
  inheritance implementation to get right. Per-category grants -> DEFERRED.md.
- Seed now writes drafts whose text **differs from the published version** for
  handbook and salaries. That divergence is the fixture the "reader sees
  published, not draft" test needs; without it the assertion would pass for the
  wrong reason. `private-idea` stays version-less to prove the no-history case.
- Phase-1 migration gotchas avoided on purpose: no `primaryKey: { columns } }`
  table option (unique `createIndex` instead), `createType`-style types, no
  backticks inside the `$$`-quoted trigger body.

## Gate hazard: two concurrent `npm run verify` runs corrupt each other

I started a second verify while the first was still in flight. Both migrate and
both `TRUNCATE ... RESTART IDENTITY CASCADE` the same `kachnadocs_test`, and the
second run's `migrate up --env=test` failed under the first — **30 of 31 tests
red, none of them for a real reason**. The green run that had just finished was
the correct answer.

One verify at a time, and read the exit code from the run you launched rather
than starting another when a log looks stalled.

## it.1 — schema assertions, and one change I tested before keeping

- Added `backend/test/cms-schema.e2e-spec.ts` (8 tests, 39 over-HTTP total): the
  immutability trigger on UPDATE and DELETE, uniqueness of (document, number),
  draft text genuinely diverging from the published snapshot, the never-published
  document having no versions, heading anchors, and category-via-group visibility.
  A schema with no test is how phase 1's SPEC.md:95 gap happened.
- **Reverted a speculative fix.** I assumed `stopServer()`'s `closePool()` left
  `db.ts` holding a dead pool for the next test file in the same Jest process,
  and wrote lazy pool re-creation for it. Running the suite disproved it: Jest
  sandboxes the module registry per test file, so each file gets a fresh pool.
  Reverted and tested the new spec as-is — 3 suites, 39 tests, green. Recorded
  because "add machinery for a problem I inferred" is the failure mode to watch.
- Real bug in my own new test, caught by running it: it called `closePool()` in
  `afterAll` *and* `stopServer()`, which had already closed it —
  `Called end on pool more than once`. The fix was to delete my call, not to
  make `closePool()` idempotent.
- DEFERRED.md: categories are deliberately not an ACL target (a third
  inheritance path would break the phase-1 single-decision-point invariant), and
  `y_state` waits for phase 3 — publish reads the same columns phase 3 will fill.
- Gate: 5 unit + 39 over-HTTP + 9 Playwright, exit 0.

## it.2 — CMS CRUD: three defects the first real caller exposed

Controllers for documents, groups and categories (`src/cms/`), replacing the
phase-1 prototype. Every read puts the ACL predicate in the `WHERE` clause rather
than asking permission and then fetching, so "no READ" and "no such row" stay one 404. Then three things broke, all of them real:

- **`groupsFilter` had never run.** Phase 1 wrote it selecting `group_id` from
  `accessible_groups()`, which returns `SETOF uuid` and therefore names its single
  column after the function. `GET /groups` was the first caller and answered 500
  `column "group_id" does not exist`. An ACL helper that is dead code is not an
  ACL helper — it is a bug with a type signature. Fixed with an alias list
  (`AS ag(grp)`).
- **The immutability trigger blocked deleting documents.** `BEFORE DELETE` on
  `document_versions` also fires for the `ON DELETE CASCADE` from `documents`, so
  any published document was undeletable. Migration 1740000006000 lets the cascade
  through by testing whether the parent row still exists — gone during a cascade,
  present on a direct delete. I checked that discriminator in psql before writing
  the migration rather than guessing from Postgres docs.
- **A cyclic `groups.parent_id` hangs the entire application.** `group_grants_for`
  recurses with `UNION ALL` and no cycle guard, so one bad reparent makes
  `accessible_*`/`can_access_*` never return. Proved with `statement_timeout`.
  Migration 1740000007000 rejects reparenting that closes a cycle; the controller
  checks too. I created a real cycle in the dev database while testing this and
  repaired it, which is the fastest possible demonstration that the guard is
  needed and that it works.
- Also: a `PATCH` body of `{parentId: undefined}` used to silently promote a group
  to top level, because `'parentId' in body` cannot tell "absent" from "explicitly
  undefined". Redefined as `body?.parentId !== undefined`.

## it.2 — versioning: what "publish" costs, and which permission it needs

`POST /documents/:id/publish`, `GET …/versions[/:number]`, `…/diff`, and
`POST …/versions/:number/restore`.

- **Publishing is MANAGE.** SPEC.md §1 names four capabilities — read, edit,
  publish, manage — against three ranks, so one has to absorb two. MANAGE absorbs
  publish. It is the only defensible direction (WRITE must not be able to make
  content visible to readers who were deliberately denied it), and `http-errors.ts`
  already documented that assumption in `forbidden()`'s comment. Restore is WRITE
  by contrast, because it touches only the draft: no reader's view moves. The
  grant/revoke test in `cms-versions.e2e-spec.ts` exists because every other
  publish denial would also pass against a route that 404'd for everyone.
- **A writer's "current version" is their draft; a reader's is the published
  head.** So `…/diff` resolves its target from what the caller may do, and a
  reader's diff provably cannot contain unpublished text (asserted).
- Concurrent publishes serialise on `FOR UPDATE` of the document row; otherwise
  two compute N and one loses on the `(document_id, number)` unique index.
- Diff is line-level LCS over Markdown, ~40 lines, no dependency. Unit-tested by
  the property the viewer depends on — dropping `add` or `remove` ops
  reconstructs either side exactly — which a server round-trip would only assert
  for the one pair of documents I happened to seed.

## Gate hazard: a stray backend server makes Playwright red

`VERIFY_EXIT=1` with **all 102 jest tests green**: `http://127.0.0.1:3100/api/health
is already used`. A `ts-node src/main.ts` from an earlier iteration still held the
port and `reuseExistingServer: false` is intentional. Killed the process; the next
run was green. When the gate is red, check which stage failed before reading test
output — a red gate with green tests is not a code problem.

## it.2 — CMS frontend, and the bug my own browser test caught

Tree (left dock) + history/diff panel (right dock), keyboard selection, state
badge, publish/history/diff/restore. Docking recorded in `stores/layout.ts` per
PLAN §2.6; the history panel is its own view rather than part of the tree, because
SPEC.md §1 calls it a "version history panel" and PLAN §2.6 makes a module a view —
which also keeps both movable.

- **The tree hid documents the API had just said the caller may read.** My first
  version built the hierarchy from `GET /groups`, but that resolves _group_ grants:
  Carl holds READ on one document directly and on no group, so he gets zero groups
  back and my tree rendered empty for him. Playwright caught it (`toHaveCount(1)`,
  received 0). Any group with no visible entry now gets a header from the name the
  document itself carries. A tree that shows only what the groups endpoint returned
  is not ACL-filtered, it is ACL-_narrowed_ — a different and quieter bug.
- **`NONE` is now selectable in the grant editor**, which phase 1 deferred until the
  override could appear next to something. It is separated from READ/WRITE/MANAGE by
  a divider and gains an explanation when chosen, because its one non-obvious
  property — it beats inheritance — is the thing a manager must not learn later.
- Response shapes moved to `shared/` (PLAN §1: the workspace exists so the frontend
  cannot drift). A controller that renames a field now breaks `vue-tsc`.
- The tree's capability computation reads `/permissions/effective` plus the group
  chain, and **cannot** see a `NONE` override (deny is not a permission, so it is
  absent from that response). So `can()` only ever _adds_ affordances and the API's
  404 stays the real answer — noted in `stores/cms.ts` rather than papered over.
- Both panels call `ensureLoaded()`, which shares one in-flight request. Neither can
  own the initial fetch: they are independently dockable, so a tree-owned load left
  the history panel empty whenever the left sidebar was hidden.
- Deliberate: the snapshot renders as Markdown in a `<pre>`, not styled ProseMirror.
  Tiptap is phase 3 and a second formatter would mean two definitions of what a
  document looks like.

## it.2 — SPEC.md §1: the ten function bullets, and one expected-behavior clause

All ten bullets under §1 "Funkce" are implemented and asserted: hierarchy, the
five document mutations, draft/published separation, publish, immutable version,
history with author/time/comment, open + diff an older version, restore as new
draft, the three states in the UI, and read/edit/publish/manage permissions.

§1's separate "Očekávané chování" paragraph adds "Publikování vytvoří novou
položku v historii verzí **a informuje ostatní klienty o změně**." The first half
is implemented; the second needs a transport to inform anyone over, and the
y-websocket server is phase 3 (PLAN §5), with PLAN §4 putting "publish→reader
refresh" in Playwright's realtime scope for the same reason. Phase 2 ships the
pull path: the panel refetches after a publish and a reader's next request sees
the new head. Written to DEFERRED.md rather than treated as satisfied, since the
phase rule is about the function bullets and this is not one — but a clause that
is unmet should be written down as unmet regardless of which list it sits in.

Gate: 13 unit + 98 over-HTTP + 12 browser, exit 0.

## it.3 — a count that disclosed a hidden document

`GET /groups` and `GET /categories` returned `documentCount` as a bare
`count(*)` over every document in the group. Both list endpoints filtered the
groups themselves through the ACL, so the filtering *looked* present, and the
count subquery was simply never given the same treatment. Ana — HR role, so she
inherits READ on Payroll, plus an explicit `NONE` on the one document there — saw
her tree render "Payroll 1" above an empty set of Payroll rows. The group was
legitimately visible to her and the document was not, so that digit told her a
document exists that the API would answer 404 for. PLAN §3.3 is exactly about
this, and the count is the same class of object as a row: an assertion that
something exists.

I did not find this by reading the SQL. I found it by printing the rendered tree
out of a real browser in a throwaway `e2e/probe.spec.ts` and getting
`.row.group [["▸HR1","0"],["▸Payroll1","1"]]`. The number was wrong on screen
while every API assertion I had written was passing, because none of them
compared a count to anything. Reading `groups.controller.ts` had not raised a
doubt in it — the surrounding code is so thoroughly ACL-filtered that the one
unfiltered expression read as part of the pattern rather than the exception. The
PATCH path had a narrower version of the same thing: a group MANAGER who holds
`NONE` on one document could read the stale count on a move.

The guard test is deliberately awkward. Asserting one expected number ("Ana's
Payroll count is 0") would only ever cover the pair I noticed, and the obvious
way to compute an expected count — the same SQL, with `can_access_document`
threaded through — would have agreed with the leak, because the leak *is* that
expression's absence. So the test compares two independently filtered HTTP
endpoints instead: every `documentCount` from `/groups` and `/categories`
against what `/documents` actually lists for the same actor, collecting
mismatches and asserting the list is empty. It holds for four actors and every
group and category at once. Confirmed it fails without the fix:
"group Payroll: count says 1, listing shows 0" and the same for the category.

My first version of that test was wrong before it ever ran. I expected Bona's
Payroll count to be 1 after moving a document into it; her `/documents` lists
only the two Engineering documents she owns readable, because READ on a group is
not READ on its whole subtree listing. The mistake was assuming a count and a
listing answer the same question — which is the assumption that produced the bug
in the first place. Written from the fixture rather than from reasoning about it.

Also caught at compile time, twice over: I passed a message as a second argument
to `expect(...)` (that is Playwright's signature, jest's `expect` takes none),
and the negative-control run then showed a second wrong expectation — I checked
"the document is really there and readable by someone" as Bona, who cannot read
it; her grants are Engineering only. That precondition belongs to the database
with no ACL in sight, since its whole job is to be a fact the filtered query
could not fake.

Gate: 13 unit + 103 over-HTTP + 13 browser, exit 0 on the committed tree.
