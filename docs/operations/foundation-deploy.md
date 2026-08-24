# Production foundation deployment

## Release identity

Build once from a clean checkout. Set `RELEASE_SHA` to `git rev-parse HEAD`;
the value must be exactly 40 lowercase hexadecimal characters. API, worker,
cron, migration, web build metadata, OCI labels, and gate evidence must all use
that same value. Each Node artifact embeds the value and rejects a missing,
malformed, or different runtime value before opening a listener or claiming
work. Railway builds also require `RAILWAY_GIT_COMMIT_SHA`, and Vercel builds
require `VERCEL_GIT_COMMIT_SHA`; the provider-supplied checkout SHA must equal
`RELEASE_SHA`. Do not replace either provider value with a manually chosen SHA.
Every API release build and runtime must also set `NODE_ENV=production`
explicitly. Omission is invalid and never falls back to local non-Secure staff
cookies. The API image and Railway API start command both supply the production
default; local API development must set `NODE_ENV=development` explicitly.

Node 22.22.2, npm 10.9.7, PostgreSQL 16.14, and Playwright 1.62.1 are the pinned
foundation toolchain. Secrets belong in provider secret stores, never CI,
container layers, config files, logs, or evidence.

## Separate processes and configuration paths

Configure five independent services and explicitly select the matching config:

| Service | Config path | Image/process | Database authority |
|---|---|---|---|
| migration release job | `infra/railway/migrate.toml` | dedicated `apps/api/Dockerfile.migrate`; `/app/migrate.js` | `DATABASE_MIGRATION_TARGET=production` plus direct `DATABASE_DIRECT_URL` |
| API | `infra/railway/api.toml` | `/app/server.js` | distinct member/staff safe LOGIN URLs |
| worker | `infra/railway/worker.toml` | `/app/runner.js` | safe worker LOGIN URL |
| one-shot cron | `infra/railway/cron.toml` | dedicated `apps/worker/Dockerfile.cron`; `/app/cron.js` | safe worker LOGIN URL |
| web | hosting-project config | Next standalone artifact | no database URL or privileged provider secret |

The cron attempts one PostgreSQL advisory lock, verifies readiness, and invokes
the idempotent `cleanup_staff_auth(statement_timestamp(), 500)` maintenance
function once. An overlapping/already-running invocation performs no work and
exits zero. Database connect/query, readiness/maintenance work, advisory unlock,
and pool close all have hard bounds; aborts propagate to in-flight work and
destroy the checked-out connection so its session lock is released. Any actual
readiness, maintenance, timeout, unlock, or close failure exits nonzero. The
long-running worker stops claiming on termination and drains in-flight fenced
jobs. None of API, worker, cron, or web runs migrations on boot.
The migration URL must be a direct PostgreSQL endpoint; pooler hostnames and
`pgbouncer` connection parameters fail closed before a migration starts.

## Release order and health

Deploy in this order:

1. Run the migration release job exactly once.
2. Deploy API and require `/v1/health/live`, then `/v1/health/ready`.
3. Deploy the long-running worker and confirm SHA-bound `ready` evidence.
4. Run the one-shot cron and confirm a zero exit after completion.
5. Deploy web and confirm `/api/health` reports the same SHA.

The production canonical origin is `https://app.syntholo.com`. Vercel serves
the web application and rewrites relative `/v1/**` requests to Railway; the
browser never receives the Railway origin as its API base URL. Cloudflare Access uses
`https://app.syntholo.com/v1/staff/auth/callback`, and its application homepage
and initiate-login URI use the same host. Clerk uses DNS mode at
`clerk.app.syntholo.com`, while the embedded `/sign-in` and `/sign-up` routes
link only to each other. No hosted Account Portal DNS record is part of the
current launch contract.

API liveness proves only process life. API readiness first requires the exact
legacy `0007_runtime_contract` projection—unchanged for migration-first rolling
deploys and API rollback—then requires the additive, versioned
`0008_account_name` projection. Together they prove database connectivity, the
immutable ordered `0001`–`0007` journal hashes and exact 0008 journal row/hash,
required foundation objects/schema/capability, and the owned/validated account-
name predicate, constraint, compatibility trigger, and ACLs without exposing
connection strings, role topology, or provider details.

## Gate and evidence

Run:

```bash
RELEASE_SHA="$(git rev-parse HEAD)" npm run gate:foundation
```

The versioned `foundation-gate.json` and image/deployed evidence use the exact
schema identifier `syntholo.foundation-gate.v1` and record environment, SHA,
named status, duration, command/artifact hash, and redacted reason. Independent
checks keep running after failures. Local absence of Docker is never recorded as image
success: the Docker-capable CI image job builds with `--no-cache`, inspects
numeric user/process/label/files/history, smoke-tests missing configuration,
creates CycloneDX SBOMs, and blocks unresolved high/critical runtime findings.

Vulnerability exceptions require a documented CVE, affected artifact digest,
reachability analysis, compensating control, named owner, approval, and expiry.
There are no permanent or severity-wide exceptions.

The engineering gate is `BLOCKED` until the four image contracts have valid
SHA-bound evidence whose environment is exactly `ci`. Production launch can
remain `BLOCKED` after engineering passes. Launch also requires fresh deployed
same-origin proxy evidence for exact
status/body, multiple `Set-Cookie`, `Location`, staff `Cookie`, and member
`Authorization` preservation, bound to the SHA, environment, canonical host,
fixed upstream, timestamp, and artifact hash. That deployed evidence also
contains the same release's fresh, independently timestamped worker `ready`
record with `service: "worker"`. Preview deployments receive
no production auth/session/API credentials and cannot target production
upstreams. Requests to production aliases and provider deployment hosts receive
a permanent redirect to the fixed `WEB_ORIGIN`; request headers never choose the
redirect or API upstream destination.

## Rollback and Git ancestry

On rollback, disable the affected feature capability first, then restore the
last compatible API/worker/cron/web artifacts. Do not reverse a destructive
migration as an improvised rollback.

The production branch currently has unrelated ancestry from `origin/main`.
After all foundation tasks are accepted, an owner must deliberately merge
`origin/main` with unrelated histories allowed, preserve the complete Syntholo
README, rerun the full gate, push normally, and configure protected required
checks. Never force-push or overwrite `main`.
