# Phase 1 — Scaffold, then identity + fine-grained ACL

Ralph loop prompt for phase 1. Re-read this file at the start of every iteration; it may have been edited
since the last one. Also read ralph/PLAN.md (architecture, decisions, guardrails) and SPEC.md (requirements).

## Iteration procedure

1. Read ralph/PLAN.md, then this file, then `ralph/FINDINGS.md` if it exists. Check `git log --oneline -15` and
   `git status` to see where the previous iteration stopped.
2. Pick the highest-priority unfinished item below. Do that one thing. Commit it.
3. Run `npm run verify`. If it fails, fixing it outranks starting anything new.
4. Append progress or blockers to `ralph/FINDINGS.md`.

## Part A — scaffold (do this first, in the earliest iterations)

- npm workspaces monorepo: `backend/` (NestJS), `frontend/` (Vue 3 + Vite + Pinia), `shared/`. TS strict
  everywhere. ESLint + Prettier at the root.
- `docker-compose.yml` with `postgres` on `pgvector/pgvector:pg17`, plus a separate test database.
  `.env.example` documents every variable.
- node-pg-migrate migrations, `npm run seed` (idempotent).
- Swagger at `/api/docs`. Health endpoint.
- **The verify gate from ralph/PLAN.md §4, working, before any feature work.** A gate that does not run is the
  single worst outcome of this phase. Playwright must be installed with a chromium browser and have one
  trivially passing spec so `npm run test:e2e` is proven wired.
  - `npm run lint` needs root eslint + prettier config files: the npm scripts exist but the configs do not.
    Creating them is part of the gate, not an afterthought.
  - The e2e suite must **boot the API and hit it over HTTP**, not just typecheck. Two real defects (a
    missing composite primary key, a wrong-arity SQL call) were invisible to `tsc` and only appeared once
    the server was running.
- Frontend shell: activity ribbon, left/right sidebars, main area, view-docking store (§2.6). Empty views
  are fine at this point — the shell must just build and render.
- Migration gotchas already paid for, do not repay them: node-pg-migrate's `primaryKey: { columns: [...] }`
  table option emits **no** constraint; `pgm.createEnum()` returns a statement, not a type name (use
  `pgm.createType`); backticks inside a `pgm.sql` template literal terminate the JS string.

## Part B — SPEC.md §3, the actual phase goal

Backend:

- `users`, `discord_roles`, `user_discord_roles`, `permissions` (subject = user **or** discord role;
  target = group **or** document; grant = `READ` | `WRITE` | `MANAGE`).
- `IdentityProvider` interface, `DevIdentityProvider` (default, seeded identities), `DiscordOAuthProvider`
  implemented against a mocked HTTP client and activated only by `DISCORD_CLIENT_ID`. Session/JWT issuance.
  `docs/discord-oauth.md`: how to enable real OAuth, step by step, with external links.
- Discord role synchronization (SPEC.md:86) behind a service, tested against a mocked gateway/API.
- `PermissionService` as the single decision point: document grant overrides inherited group grant, default
  deny. `GET /permissions/effective?userId=` returns grants **with their source** (`zděděno z HR` vs
  `přiděleno přímo`) as SPEC.md:84 requires.
- SQL-level ACL filtering helper used by every later read path. Build it now even though only stub queries
  use it — phases 2–5 depend on it existing.

Tests (this is what the phase really is about — the security invariants in ralph/PLAN.md §3):

- Inheritance, override, deny-by-default, role-derived grants.
- Every denial path returns the same 404 shape as a nonexistent resource, asserted explicitly.
- A test that fetches document content by ID with an unauthorized actor and asserts denial, so "UI hides it"
  can never be mistaken for enforcement.

Frontend: minimal permissions admin view — list grants, add grant for a user or Discord role, show effective
permissions with source. Enough to prove the API, not polished.

## Definition of done for this phase

`npm run verify` exits 0, and every function bullet in SPEC.md §3 is implemented or listed in
`ralph/DEFERRED.md` with a reason. `docs/discord-oauth.md` exists. Then, and only then, output exactly:

<promise>AUTH DONE</promise>

If stuck after 3 iterations on one item: write it to `ralph/FINDINGS.md`, narrow it, move to another item. Never
emit the promise to end the loop.
