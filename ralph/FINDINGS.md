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
