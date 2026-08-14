# Task 9 report — foundation CI, deploy processes, and gate evidence

Date: 2026-08-14

## Outcome

Implemented the complete Task 9 production-foundation boundary from accepted
Task 8 commit `084d7e463d52960c5843a53d8f0096c55ed09b99`.

- Added a versioned SHA-bound foundation gate with named, independently
  attributed checks, bounded timeouts, redacted reasons, durations, and
  artifact/command hashes. Engineering and production-launch states are
  separate; missing deployed evidence never becomes a local false pass.
- Added pinned CI for Node 22.22.2, npm 10.9.7, PostgreSQL 16.14, Playwright
  1.62.1/Chromium, read-only permissions, immutable Action SHAs, full history,
  concurrency cancellation, real-PG suites, clean images, inspection, startup
  smoke tests, graceful drain, SBOMs, and blocking high/critical scans. CI has
  ephemeral test credentials only.
- Added clean multi-stage, digest-pinned, numeric-non-root API, migration,
  worker, and cron image targets and explicit Railway config paths/processes.
  Migration is an explicit one-owner production release job; API, worker,
  cron, and web do not migrate on boot.
- Embedded and enforced an exact 40-lowercase-hex release SHA in API, worker,
  migration, and Next artifacts. Runtime configuration must match the embedded
  identity, health payloads expose the same SHA, and OCI labels/CI evidence are
  bound to it.
- Added additive migration `0006_runtime_readiness` and a narrow
  `SECURITY DEFINER` projection for the exact six-entry journal, schema marker,
  actual runtime login, and one expected capability. API readiness and the
  one-shot advisory-locked cron use it without exposing database detail.
- Removed MongoDB, HighLevel, server Stripe, Resend, Blob, and privileged Mux
  adapters plus the web Stripe write route. Strict web parsing rejects even
  blank database/provider secrets and preview API/auth linkage. Production
  graph scanning covers manifests, static/dynamic/alias imports, web source,
  Next server/static/standalone output, lockfile edges, URLs, and secrets.
- Preserved public analytics and browser integrations. The shared PostHog type
  moved to `apps/web/src/lib/analytics/types.ts`; PostHog remains tested. Clerk
  UI moved from the secret-aware Next server package to browser-only
  `@clerk/react`, retaining public sign-in/up while keeping built artifacts free
  of Clerk server-secret lookups.
- Preserved the fixed same-origin `/v1` beforeFiles proxy and added an
  instrumented local upstream test proving exact status/body, two
  `Set-Cookie` headers, `Location`, staff `Cookie`, and member `Authorization`.
  Deployed canonical-host evidence remains a production launch requirement.
- Rewrote `.env.example`, README, demo/production guidance, and the deployment
  runbook so no obsolete MongoDB/HighLevel/web-secret or demo-as-production
  path is advertised.

## RED to GREEN evidence

Initial RED slices failed because the gate/evaluator, release identity helpers,
strict web boundary, narrow readiness projection, worker health/cron lifecycle,
and artifact embedding did not exist. Later boundary REDs also proved that
blank Clerk/analytics/other API secrets, demo-mode preview linkage, HighLevel
SDK edges, and cron/migration image commands were not yet covered. The real
production graph then caught `@clerk/nextjs` server-secret lookups in built Next
output; the implementation retained Clerk through the public browser-only
package rather than weakening the scanner.

Focused GREEN commands included:

- `npm test -w @syntholo/testing -- gate-foundation.test.ts foundation-gate-policy.test.ts`
  — 2 files, 16 tests passed.
- `npm test -w @syntholo/web -- src/lib/config/env.test.ts src/lib/api/client.test.ts`
  — 2 files, 39 tests passed after strict-boundary additions.
- API release/health and legacy fixture suites — 131 tests passed in the final
  workspace run.
- Worker runner, cron, release, and health suites — 41 tests passed.
- Database readiness plus existing schema/config unit suites — 100 tests
  passed.

## Fresh local verification

- `npm run typecheck` — PASS in all eight workspaces.
- `npm run lint` — PASS in all eight workspaces.
- `npm test` — PASS: 53 files and 635 tests across eight workspaces.
- `RELEASE_SHA=084d7e463d52960c5843a53d8f0096c55ed09b99 APP_MODE=demo npm run build`
  plus `npm run build:migrate` — PASS. Next `BUILD_ID` equals the SHA; API,
  worker, cron, migration, and Next output contain it.
- `node --check` for API `server.js`, worker `runner.js`/`cron.js`, migration
  `migrate.js`, and all new infrastructure scripts — PASS.
- Empty-environment startup of all four built Node processes — expected
  nonzero with exact fixed output only: `API_STARTUP_FAILED`,
  `WORKER_STARTUP_FAILED`, or `MIGRATION_STARTUP_FAILED`.
- `CI=false npm run test:e2e` — PASS: 63 passed, 17 intentional
  project-specific skips, one browser worker. Both desktop/mobile proxy tests,
  accessibility scans, keyboard, responsive, journey, and local visual
  contracts passed.
- CI YAML parse, production dependency-graph inspection, and
  `git diff --check` — PASS. The final graph has no forbidden packages/imports,
  web secret keys, HighLevel API URLs, lockfile edges, or built artifacts.

The real command
`RELEASE_SHA=084d7e463d52960c5843a53d8f0096c55ed09b99 npm run gate:foundation`
produced valid JSON and continued after failures. Local PASS checks were
`workspaces`, `artifacts`, `browser`, `repository`, `releaseSha`, and
`dependencyPolicy`. It correctly exited 1 because `TEST_DATABASE_URL` is unset
and no PostgreSQL client/server is installed, so `migrations`, `rls`, the
database portion of `identitySeparation`, `jobs`, and `entitlements` cannot run
here. `images`, deployed `proxy`, and target `ancestry` remain explicitly
`BLOCKED`, never PASS.

## Unavailable evidence and launch concerns

- Docker is unavailable locally. No local image-build, inspection, runtime,
  SBOM, or vulnerability result is claimed. The Docker-capable CI image job is
  the required source of that evidence and covers API/migration/worker/cron.
- Real PostgreSQL 16.14 evidence is unavailable locally because
  `TEST_DATABASE_URL` is unset and `pg_isready` is not installed. The pinned CI
  service runs the migration/RLS/ACL/identity/job/entitlement suites.
- The local same-origin proxy test is green, but fresh deployed canonical-host
  evidence with SHA, host, upstream, time, and artifact hash is still required.
- `origin/main` still has unrelated ancestry. The documented owner action is a
  deliberate unrelated-history merge after foundation acceptance, followed by
  a full rerun and normal push. No force-push is authorized or performed.
- `npm install --package-lock-only` reports four moderate audit findings in the
  full development dependency tree. CI generates production/image SBOMs and
  blocks all high/critical runtime findings; no exception is pre-approved.

Implementation and tests are committed with this report in
`ci: verify production foundation gate`. No push was performed.

DONE
