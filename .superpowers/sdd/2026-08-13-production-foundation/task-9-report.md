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
- Kept immutable migration `0006_runtime_readiness`, added additive
  `0007_runtime_contract`, and exposed a narrow `SECURITY DEFINER` projection
  for the exact seven-entry journal, schema marker, actual runtime login,
  migration-owned objects, and one expected capability. API readiness and the
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

## Acceptance fix round 1 — 2026-08-14

The acceptance findings against commit
`5e9c259b42193f3297c2470dc1f0d78bc8be21d5` were reproduced before the
fixes. Focused RED runs initially produced 12 foundation-policy failures, 10
database-contract failures, four web configuration/canonical-host failures,
and one worker-health failure. The implementation now closes each reported
trust-boundary gap:

- Railway no longer depends on the unsupported `build.dockerfileTarget`
  property. Migration and cron use dedicated default-runtime Dockerfiles, all
  four checked-in configs use provider-supported keys, and their exact default
  image commands are tested. Current Railway documentation/schema was checked
  for `dockerfilePath`, exec-form Docker start-command overrides, build-time
  `ARG` values, `RAILWAY_GIT_COMMIT_SHA`, and `cronSchedule`.
- Release certification now compares `RELEASE_SHA` to `HEAD` and rejects any
  tracked or untracked worktree change before building or certifying artifacts.
  Both hostile cases execute against a real temporary Git repository in the
  policy test. A dirty-tree invocation reports all 14 catalog checks and
  attributes `REPOSITORY_DIRTY` without executing production work.
- Railway and Vercel builds fail closed unless their provider-supplied checkout
  SHA is present, valid, and exactly equals `RELEASE_SHA`. CI passes the exact
  GitHub SHA to all four clean Docker builds; Railway Git-triggered builds use
  the provider-injected build argument, and Vercel validates
  `VERCEL_GIT_COMMIT_SHA` in `next.config.ts` evaluation.
- Immutable published migrations `0001` through `0006` remain byte-for-byte
  unchanged and now have a frozen ordered tag/index/time/SHA-256 inventory.
  Additive `0007_runtime_contract` exposes the exact seven ordered journal
  hashes plus all 27 migration-owned runtime tables. Rewritten, missing, and
  reordered journal/file fixtures fail before Drizzle executes; readiness
  fails on any hash, object, marker, or capability mismatch. Production
  migration configuration rejects pooler hostnames and PgBouncer parameters.
- The gate has an exact 14-check schema/catalog with validated status,
  duration, command, artifact hash, environment, timestamp, release identity,
  and derived state. Images are engineering evidence; deployed proxy and
  ancestry are launch-only evidence. Missing local database infrastructure is
  `BLOCKED`; missing CI database configuration is `FAILED`; malformed supplied
  evidence is `FAILED`. Exit behavior is covered for PASS, BLOCKED, and FAILED.
- The test-only synthetic all-PASS CLI path was removed. Required prior-task
  contracts are validated by named content, and real CLI results can come only
  from executable commands and SHA-bound artifacts.
- Production scanning covers MongoDB, HighLevel packages/credentials/API,
  OAuth/SSO/token URLs, Stripe server, Resend, Blob server, privileged Mux,
  static/dynamic imports, nested TypeScript path aliases, manifests, lockfile
  edges, and built Next/Node output while retaining approved public SDKs and
  customer-facing external-link copy. The final graph resolves 65 real alias
  edges and has zero forbidden runtime findings.
- Next 16 Proxy now permanently redirects every production alias/provider host
  to the fixed validated `WEB_ORIGIN`, preserving path/query. Exact canonical
  requests and demo preview hosts do not redirect; the existing strict preview
  parser still rejects production auth/upstream linkage.
- CI now uploads JUnit and V8 coverage for all eight workspaces, includes all
  four image SBOM/vulnerability scans (including cron), validates secret-free
  startup/drain logs, polls for a SHA-bound worker-ready record, emits complete
  SHA-bound image evidence, and makes the foundation job consume that evidence.
  Deployed proxy evidence additionally requires the same SHA's worker-ready
  record. Image evidence is downloaded under the runner temporary directory so
  it cannot make the source checkout dirty.

### Acceptance-fix verification

- `npm run typecheck` — PASS in all eight workspaces.
- `npm run lint` — PASS in all eight workspaces.
- `npm test` — PASS: 55 files and 661 tests across eight workspaces (API 131,
  web 101, worker 42, contracts 15, database 109, domain 193, integrations 35,
  testing 35).
- `npm run test:coverage` — PASS for all eight workspaces, with eight JUnit XML
  files plus V8 JSON/text coverage output. The database unit-only coverage is
  intentionally distinct from the real-PostgreSQL integration job and is not
  represented as integration coverage.
- `RELEASE_SHA=$(git rev-parse HEAD) APP_MODE=demo npm run build`, followed by
  `RELEASE_SHA=$(git rev-parse HEAD) npm run build:migrate` and `node --check`
  for API, worker, cron, and migration artifacts — PASS. Next reports the
  canonical-host implementation as `Proxy (Middleware)`.
- `CI=false npm run test:e2e` — PASS: 63 passed, 17 intentional
  project-specific skips, 80 total, one browser worker.
- Focused final checks: database migration/readiness 10/10; foundation policy
  22/22; web build/canonical-host 10/10; worker health 6/6 — PASS.
- Railway topology/content validation — PASS for API, migration, worker, and
  cron. Unsupported `dockerfileTarget` is absent. CI YAML parse and
  `git diff --check` — PASS.
- Final production graph — PASS with zero forbidden packages, imports,
  environment keys, URLs, lockfile packages, or built artifacts; 65 alias
  edges were resolved.
- `npm audit --audit-level=high` — exit 0 with the existing four moderate
  development-only `drizzle-kit`/legacy esbuild-chain findings. The offered fix
  is a breaking `drizzle-kit` downgrade and was not applied. Clean CI image
  scans remain fail-closed at HIGH/CRITICAL.

One verification run launched `npm test` concurrently with an artifact build;
the build correctly replaced the worker fixture artifact while its unit test
was reading it. Sequential verification removed the shared-output race: worker
42/42 and the full 661-test run pass. All final verification commands above
were run sequentially where they share `dist` or `.next` output.

Docker, `psql`, and `TEST_DATABASE_URL` are unavailable on this host. No local
image or real-PostgreSQL PASS is claimed. The clean-image/SBOM/scan/startup and
real-PG migration/RLS/ACL/race evidence remains CI-blocked until the pinned
jobs run. Fresh deployed canonical proxy plus worker-ready evidence and target
branch ancestry remain launch-blocked. The clean committed-SHA gate is rerun
immediately after this report is committed; its exact state is returned with
the commit handoff because a report cannot contain evidence for its own future
Git object.

No push was performed.

DONE

## Acceptance fix round 2 — 2026-08-14

The remaining review findings against commit
`54958d8ddc15e70018c568bc0680a74a296f87be` were reproduced with focused RED
tests, then closed without weakening a production boundary:

- Image evidence now requires the explicit `ci` environment in addition to
  its SHA and exact API/migration/worker/cron service set. Missing or alternate
  environments fail validation.
- Required-contract validation now parses executable TypeScript tests and
  binds every one of the 14 catalog check IDs to exact active test titles and
  assertions. Comments, skipped/todo tests, empty bodies, and bodies without
  the required behavior cannot satisfy the contract. The synthetic all-PASS
  rejection remains covered.
- Production dependency policy is enforced over reachable source and built
  entries, TypeScript path aliases, dynamic imports, workspace exports, and
  lockfile production closures. MongoDB and HighLevel remain globally denied.
  Privileged Clerk/WorkOS server adapters and Stripe/Resend/Mux/Blob server
  adapters are denied in the web boundary while remaining permitted for API
  services where appropriate; public browser SDKs and ordinary external-link
  copy remain permitted.
- Secret-free runtime-log validation now requires exact API, cron, migration,
  and worker coverage. CI captures migration and cron output and includes
  those logs in image evidence. Deployed worker-ready evidence now has its own
  valid fresh timestamp and must identify `service: "worker"`.
- Migration tests now require the exact seven-row journal after `0007`, while
  freezing the order and hashes of immutable `0001` through `0006` and the
  additive `0007_runtime_contract` hash.
- Worker readiness can no longer transition from draining back to ready if a
  termination signal arrives while its asynchronous readiness check is in
  flight. A regression holds the readiness promise open, signals shutdown,
  and proves that the ready transition is never called.

### Acceptance-fix round 2 verification

- Focused foundation-policy/CLI — 36/36 PASS; worker runner/health — 40/40
  PASS; database migration/readiness — 10/10 PASS.
- `npm test` — PASS: 55 files and 673 tests across eight workspaces (API 131,
  web 101, worker 44, contracts 15, database 109, domain 193, integrations 35,
  testing 45).
- `npm run typecheck`, `npm run lint`, and `npm run test:coverage` — PASS in all
  eight workspaces. Coverage produced eight JUnit reports and V8 output.
- Clean release builds for web/API/worker/cron/migration plus Node syntax
  checks — PASS. Empty-environment startup of all four Node processes failed
  closed with exact fixed stderr and no stdout.
- `CI=false npm run test:e2e` — PASS: 63 passed, 17 intentional
  project-specific skips, 80 total, one browser worker.
- CI YAML/config validation and Railway topology validation — PASS. The final
  production graph resolves 448 runtime imports and reports zero policy
  violations. `git diff --check` — PASS.
- `npm audit --audit-level=high` — exit 0 with the existing four moderate
  development-only legacy-esbuild findings through `drizzle-kit`; the offered
  force fix is a breaking downgrade and was not applied.

Docker, `psql`, and `TEST_DATABASE_URL` remain unavailable on this host. No
local image or real-PostgreSQL PASS is claimed. Fresh deployed proxy/worker
evidence and target-branch ancestry also remain launch-blocked until their
external evidence is available. The clean committed-SHA gate is rerun after
this report is committed, and its exact state is returned in the commit
handoff. No push was performed.

DONE

## Acceptance fix round 3 — 2026-08-14

The two remaining Important findings against commit
`f7f99d3914e9e2105cce9e5f1a22fa50fa765f9c` were reproduced with direct
negative fixtures before either implementation changed.

- Required-contract validation now walks only top-level registrations and
  handlers of active, unconditional suites. Skipped suites, conditional suites,
  conditionally registered tests, skipped/todo/conditional tests, empty tests,
  assertion-free behavior, bare token references, and assertions hidden in
  uncalled helpers cannot satisfy a contract. Every accepted test has an
  executable assertion and every required contract identifier occurs in an
  executed call/assertion evidence subtree rather than arbitrary body text.
- The production graph now inventories forbidden packages copied into the Next
  standalone runtime, follows `.nft.json` file edges under the originating web
  scope, and resolves aliases inherited from `tsconfig.base.json`. Lock closure
  begins at root optional dependencies as well as each service, follows
  dependency/optional/peer edges, resolves npm's nearest versioned lock path,
  and dereferences workspace links without merging same-name packages across
  versions. Privileged server adapters remain allowed in API closure while the
  web closure continues to reject them.
- The initial focused RED had 11 expected failures covering six graph gaps and
  five non-executing validator forms. Two strengthened mutation cycles then
  separately proved a standalone forbidden JavaScript file (without relying on
  its package manifest) and an assertion hidden in an uncalled helper were
  rejected only after their respective implementation slices.

### Acceptance-fix round 3 verification

- Focused foundation policy — 44/44 PASS.
- `npm run typecheck` and `npm run lint` — PASS in all eight workspaces.
- `npm test` — PASS: 55 files and 685 tests across eight workspaces (API 131,
  web 101, worker 44, contracts 15, database 109, domain 193, integrations 35,
  testing 57).
- Clean release builds for web/API/worker/cron/migration and `node --check` for
  all four Node artifacts — PASS. Empty-environment startup of API, worker,
  cron, and migration failed closed with status 1, empty stdout, and the exact
  fixed service error on stderr.
- `CI=false npm run test:e2e` — PASS: 63 passed, 17 intentional
  project-specific skips, 80 total, one browser worker.
- The final production graph follows 6,978 runtime, NFT, alias, workspace, and
  standalone edges and reports `policyPass: true` with zero violations.
  `git diff --check` — PASS.

Docker, `psql`, and `TEST_DATABASE_URL` remain unavailable on this host. No
local image or real-PostgreSQL PASS is claimed. Fresh deployed proxy/worker
evidence and target-branch ancestry also remain launch-blocked until their
external evidence is available. The exact clean committed-SHA foundation gate
is rerun after this report is committed, and its result is returned with the
commit handoff. No push was performed.

DONE

## Acceptance fix round 4 — 2026-08-14

The final Important validator finding against commit
`d077f588646bab6904535870592074587b9003bc` was reproduced with six direct
negative fixtures before the implementation changed.

- Required-test registration traversal now carries active, conditional, and
  skipped state through nested suites and control-flow nodes. The right-hand
  side of each short-circuit operator (`&&`, `||`, and `??`) is conditional, so
  a required contract hidden behind any of those operators cannot satisfy the
  gate.
- Assertion evidence now requires an actual `expect(value).matcher(...)` chain,
  a recognized invocation imported from `node:assert` or `node:assert/strict`,
  or the retained exact `fc.assert(...)` property-contract form. Static helper
  definitions and lookalike calls such as `assert.log(...)`,
  `expect.soft(...)`, and `expect.extend(...)` no longer count as assertions.
- Positive fixtures cover both a normal Vitest matcher chain and an imported
  Node assertion invocation. The complete real required-contract catalog is
  also revalidated by the focused policy suite.

The focused RED contained exactly six expected failures: one for each of the
three short-circuit registrations and one for each assertion lookalike. After
the implementation, the focused foundation-policy suite passed 51/51 and the
combined foundation-policy/CLI slice passed 55/55.

### Acceptance-fix round 4 verification

- `npm run typecheck` and `npm run lint` — PASS in all eight workspaces.
- `npm test` — PASS: 55 files and 692 tests across eight workspaces (API 131,
  web 101, worker 44, contracts 15, database 109, domain 193, integrations 35,
  testing 64).
- Clean release builds for web/API/worker/cron/migration and `node --check` for
  all four Node artifacts — PASS.
- `CI=false npm run test:e2e` — PASS: 63 passed, 17 intentional
  project-specific skips, 80 total, one browser worker.
- The production graph follows 6,978 resolved runtime edges and reports
  `policyPass: true` with zero violations. `git diff --check` — PASS.

Docker, `psql`, and `TEST_DATABASE_URL` remain unavailable on this host. No
local image or real-PostgreSQL PASS is claimed. Fresh deployed proxy/worker
evidence and target-branch ancestry also remain launch-blocked until their
external evidence is available. The exact clean committed-SHA foundation gate
is rerun after this report is committed, and its result is returned with the
commit handoff. No push was performed.

DONE

## Acceptance fix round 5 — 2026-08-14

The two final Important validator bypasses against commit
`80af2a02844283a45bbcef37f77ffa49e98c447a` were reproduced with six direct
negative fixtures before the implementation changed.

- Required-test registration traversal now propagates conditional state to the
  right-hand side of logical assignment (`&&=`, `||=`, and `??=`) as well as
  the existing short-circuit operators. A required contract registered through
  any of those assignment operators cannot satisfy the gate.
- Assertion evidence now rejects assertion roots shadowed by handler-local
  value bindings. Imported default `assert`, imported named methods such as
  `equal`, global `expect`, and `fc.assert` are accepted only when the active
  test handler does not bind the same root identifier; nested helper internals
  remain outside executable evidence collection.
- Positive controls retain unshadowed global `expect`, default Node assert, and
  named Node assert support. The complete repository contract catalog remains
  accepted by the focused policy suite.

The focused RED contained exactly six expected failures: one for each logical
assignment registration and one for each shadowed default assert, named equal,
and expect binding. After the implementation, the focused foundation-policy
suite passed 58/58 and the combined foundation-policy/CLI slice passed 62/62.

### Acceptance-fix round 5 verification

- `npm run typecheck` and `npm run lint` — PASS in all eight workspaces.
- `npm test` — PASS: 55 files and 699 tests across eight workspaces (API 131,
  web 101, worker 44, contracts 15, database 109, domain 193, integrations 35,
  testing 71).
- Clean release builds for web/API/worker/cron/migration and `node --check` for
  all four Node artifacts plus the changed gate library — PASS.
- `CI=false npm run test:e2e` — PASS: 63 passed, 17 intentional
  project-specific skips, 80 total, one browser worker.
- The production graph follows 6,978 resolved runtime edges and reports
  `policyPass: true` with zero violations. `git diff --check` — PASS.

Docker, `psql`, and `TEST_DATABASE_URL` remain unavailable on this host. No
local image or real-PostgreSQL PASS is claimed. Fresh deployed proxy/worker
evidence and target-branch ancestry also remain launch-blocked until their
external evidence is available. The exact clean committed-SHA foundation gate
is rerun after this report is committed, and its result is returned with the
commit handoff. No push was performed.

DONE
