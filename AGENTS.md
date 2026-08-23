<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

This repo's real code lives on the `codex/production-platform` branch (the `main` branch is
an empty placeholder). It is an npm-workspaces monorepo. Standard commands live in the root
`package.json` scripts and `README.md`; prefer those over duplicating them here.

### Node / toolchain (non-obvious)
- The project pins Node `22.22.2` / npm `10.9.7` (see `package.json` `engines`). That exact
  Node is installed via nvm at `~/.nvm/versions/node/v22.22.2`. Note `node` on the default
  `PATH` resolves to `/exec-daemon/node` (a different minor, `22.14.x`); the nvm bin has been
  prepended in `~/.bashrc` so interactive shells get `22.22.2`. If a command uses the wrong
  Node, run it with `~/.nvm/versions/node/v22.22.2/bin` first on `PATH`.
- The update script runs `npm ci` with that pinned npm.

### RELEASE_SHA (required almost everywhere)
Every runnable process (web/api/worker) and the production build validate a `RELEASE_SHA`
env var that must be the exact 40-char checked-out commit SHA. Export it first:
`export RELEASE_SHA="$(git rev-parse HEAD)"`. When running via `tsx` (dev), only the format
is checked; built artifacts additionally require it to match the embedded SHA.

### Services
- `@syntholo/web` (Next.js, port 3000) — the core product surface. Run `npm run dev:web`.
  It boots in `APP_MODE=demo` needing only `RELEASE_SHA`; the public funnel (`/`, `/scorecard`,
  `/pricing`, `/api/health`) is fully standalone. The web env is locked down: it throws
  `WEB_ENV_FORBIDDEN_KEY` / `WEB_API_CONFIG_INVALID` if any DB/vendor secret key
  (e.g. `*_DATABASE_URL`, `TEST_DATABASE_URL`, `WORKOS_*`, `*_SECRET`) is present in the
  environment — so never export those in a shell used to run or build the web app. The
  authenticated member (`/learn/*`) and admin (`/admin/*`) areas are API/Clerk/WorkOS-backed
  on this branch (not standalone demo fixtures) and require the API + real Clerk/WorkOS.
- `@syntholo/api` (Fastify, port 4000) — `npm run dev:api`. Boots with placeholder vendor
  keys (format-validated only) plus three DISTINCT Postgres role logins for
  `MEMBER_/STAFF_/SYSTEM_DATABASE_URL` (the config rejects reused credentials). `/v1/health/live`
  works once booted; `/v1/health/ready` also requires a fully seeded schema INCLUDING a
  published commerce catalog (`catalog_ready`), so it returns 503 "degraded" on a
  freshly-migrated DB until a catalog is published (application seed data, done via the
  commerce domain functions / integration fixtures — not an environment concern).
- `@syntholo/worker` (`npm run dev:worker`) — needs `DATABASE_URL` (a `syntholo_worker` role
  login). It fails closed with `WORKER_STARTUP_FAILED` until `checkDatabaseReadiness` passes,
  which (like the API `ready` probe) needs the published commerce catalog.

### PostgreSQL (required for integration tests + api/worker)
- Use PostgreSQL **17**, not 16. The DB readiness/attestation functions expect the `MAINTAIN`
  table privilege granted by `GRANT ALL`, which only exists in PG17+; on PG16 the
  `*_acl_ready` attestations (and thus `checkDatabaseReadiness`) fail.
- PG17 is installed. Start it with `sudo pg_ctlcluster 17 main start` (it does not auto-start).
- Provisioned to match CI: superuser role `syntholo`/`syntholo`, database `syntholo_test`.
  `TEST_DATABASE_URL=postgres://syntholo:syntholo@127.0.0.1:5432/syntholo_test`. The test
  harness (`@syntholo/testing`) auto-applies all migrations, so no manual `db:migrate` is
  needed for tests. Integration tests: `TEST_DATABASE_URL=... RELEASE_SHA=$(git rev-parse HEAD) npm run test:integration`.
- To run the API/worker as least-privilege roles, distinct login roles inheriting the
  NOLOGIN capability roles are used, e.g.:
  `member_runtime→syntholo_member_api`, `staff_runtime→syntholo_staff_api`,
  `system_runtime→syntholo_system_api`, `worker_runtime→syntholo_worker`
  (`grant <capability> to <login> with inherit true, set false, admin false;`).
  If these roles/db are missing after a fresh boot, recreate them the same way.

### Build
`npm run build` is a production build (`NODE_ENV=production`, requires `RELEASE_SHA` and an
explicit `APP_MODE`). A demo build additionally needs `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
(any format-valid `pk_...` value) because `/learn` statically prerenders a Clerk-backed
component. For day-to-day development use `npm run dev:web` instead.
