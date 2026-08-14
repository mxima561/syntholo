# Production foundation deployment

## Release identity

Build once from a clean checkout. Set `RELEASE_SHA` to `git rev-parse HEAD`;
the value must be exactly 40 lowercase hexadecimal characters. API, worker,
cron, migration, web build metadata, OCI labels, and gate evidence must all use
that same value. Each Node artifact embeds the value and rejects a missing,
malformed, or different runtime value before opening a listener or claiming
work.

Node 22.22.2, npm 10.9.7, PostgreSQL 16.14, and Playwright 1.62.1 are the pinned
foundation toolchain. Secrets belong in provider secret stores, never CI,
container layers, config files, logs, or evidence.

## Separate processes and configuration paths

Configure five independent services and explicitly select the matching config:

| Service | Config path | Image/process | Database authority |
|---|---|---|---|
| migration release job | `infra/railway/migrate.toml` | API Dockerfile target `migration-runtime`; `/app/migrate.js` | `DATABASE_MIGRATION_TARGET=production` plus direct `DATABASE_DIRECT_URL` |
| API | `infra/railway/api.toml` | `/app/server.js` | distinct member/staff safe LOGIN URLs |
| worker | `infra/railway/worker.toml` | `/app/runner.js` | safe worker LOGIN URL |
| one-shot cron | `infra/railway/cron.toml` | `/app/cron.js` | safe worker LOGIN URL |
| web | hosting-project config | Next standalone artifact | no database URL or privileged provider secret |

The cron holds one PostgreSQL advisory lock, performs its bounded readiness
work once, releases the lock, and exits. Overlap or failure exits nonzero. The
long-running worker stops claiming on termination and drains in-flight fenced
jobs. None of API, worker, cron, or web runs migrations on boot.

## Release order and health

Deploy in this order:

1. Run the migration release job exactly once.
2. Deploy API and require `/v1/health/live`, then `/v1/health/ready`.
3. Deploy the long-running worker and confirm SHA-bound `ready` evidence.
4. Run the one-shot cron and confirm a zero exit after completion.
5. Deploy web and confirm `/api/health` reports the same SHA.

API liveness proves only process life. API readiness uses the additive
`0006_runtime_readiness` projection to prove database connectivity, the exact
six-entry journal, schema marker, and expected runtime capability without
exposing connection strings, role topology, or provider details.

## Gate and evidence

Run:

```bash
RELEASE_SHA="$(git rev-parse HEAD)" npm run gate:foundation
```

The versioned `foundation-gate.json` records environment, SHA, named status,
duration, command/artifact hash, and redacted reason. Independent checks keep
running after failures. Local absence of Docker is never recorded as image
success: the Docker-capable CI image job builds with `--no-cache`, inspects
numeric user/process/label/files/history, smoke-tests missing configuration,
creates CycloneDX SBOMs, and blocks unresolved high/critical runtime findings.

Vulnerability exceptions require a documented CVE, affected artifact digest,
reachability analysis, compensating control, named owner, approval, and expiry.
There are no permanent or severity-wide exceptions.

The engineering gate may be `PASS` while production launch remains `BLOCKED`.
Launch also requires fresh deployed same-origin proxy evidence for exact
status/body, multiple `Set-Cookie`, `Location`, staff `Cookie`, and member
`Authorization` preservation, bound to the SHA, environment, canonical host,
fixed upstream, timestamp, and artifact hash. Preview deployments receive no
production auth/session/API credentials and cannot target production upstreams.

## Rollback and Git ancestry

On rollback, disable the affected feature capability first, then restore the
last compatible API/worker/cron/web artifacts. Do not reverse a destructive
migration as an improvised rollback.

The production branch currently has unrelated ancestry from `origin/main`.
After all foundation tasks are accepted, an owner must deliberately merge
`origin/main` with unrelated histories allowed, preserve the complete Syntholo
README, rerun the full gate, push normally, and configure protected required
checks. Never force-push or overwrite `main`.
