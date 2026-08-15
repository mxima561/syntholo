# Task 7 report — implementation workspace and completion authority

Date: 2026-08-15

## Outcome

Task 7 implements the account-shared implementation workspace end to end: five stable artifact roots, immutable structured versions, three normalized workflows, immutable account/course completion snapshots, strict member APIs, course-completion worker convergence, dashboard v3, and production Plan/Workflows clients. No provider production state was mutated and nothing was pushed or deployed.

## RED evidence

- Contract/domain RED was captured before production edits for the exact five artifact kinds, strict structured content, final completeness, live workflow legality, optimistic versions, and the separation between portfolio finalizability and shared completion readiness.
- Migration/static RED covered exact ownership/current-head keys, strict JSON/hash authority, incomplete drafts versus final/live completeness, receipt claim/replay, access locking, catalog readiness, worker events, and the SHA-bound journal.
- Disposable PostgreSQL/Neon RED exposed PostgreSQL 18 trigger deparse behavior, zero-based `int2vector` index options, schema-qualified CHECK deparse, exact ACL/owner behavior, system capability allowlist drift, and unsupported `max(uuid)` in completion recompute. Each failure received a focused regression before the production repair.
- API/UI RED covered strict route shapes, 404 collapse, authorization-before-replay, dashboard v3 deadline/access composition, immutable autosave retry, sticky conflicts, late-session callbacks, known-resource access loss, accessible validation, mobile navigation, and production Next.js module resolution.

## GREEN evidence

- Root unit: API 204, Web 192, Worker 70, Contracts 74, Database 219, Domain 234, Integrations 91, Testing 110 — all passing.
- Root lint and typecheck: all workspaces passing.
- Root production build: API, Next.js 16 web, and worker passing with production-safe fixture configuration.
- Production web artifact/demo/secret scan: passing; production learn payloads and client chunks contain no demo modules, member fixture data, or secrets.
- Production Playwright: 7/7 passing. Evidence includes Clerk bearer/no-cookie artifact traffic, byte-identical ambiguous retry, fresh teammate conflict comparison, sticky memory draft, late old-session GET/POST isolation, dashboard v3 Plan/Workflows/Course navigation, four 44px mobile links, no horizontal overflow, and WCAG 2 A/AA axe checks.
- Focused database migration/readiness/schema/handshake, repository, API route, dashboard, worker, domain event, and web workspace suites pass. `git diff --check` passes.
- Disposable Neon targeted startup after the TypeScript/SQL capability mirror repair: content-assets and entitlements 105 passed, 1 explicit skip, 0 failed.
- Dedicated implementation integration on final `dabb54…`: 3/3 passing, including populated upgrade/backfill, the full lifecycle/race/immutability matrix, and isolated artifacts-first worker convergence.
- Final full disposable Neon database result on exact `dabb54…`: 10 files, 180 passed, 6 explicit skips, 0 failed in 329.60 seconds. This includes populated 0011→0012 upgrade/backfill, repeat migration/journal/readiness, actor isolation, receipt races, immutable rows, both completion orders, exact snapshots/events, startup capabilities, and hostile authority drift.
- `npm run db:schema:check` against the final direct Neon URL passes and exports the exact 66-table schema with the implementation foreign keys and indexes.

## Migration and signed handshake

- Tuple: journal index `11`, timestamp `1786856400000`, tag `0012_implementation`.
- SHA-256: `dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9`.
- Migration reruns atomically and readiness attests exact relations, columns, keys, checks, indexes, triggers, policies, ACLs, function bodies, owners, upstream dependencies, receipt bindings, and seed backfill.
- Handshake fixture: `packages/database/src/schema/implementation-handshake.json` with an exact hash/DDL test in `implementation-handshake.test.ts`.
- The handshake freezes root/current-head/version/workflow/completion/snapshot keys, downstream unique `(account_id,artifact_id,id)`, state enums, system seed signature, and exact event types.
- Certificate non-authority is explicit: `implementationCompletionIsAuthority: false`; certificate eligibility remains `learning.course_completed.v1`.

## Major implementation areas

- `packages/contracts` and `packages/domain`: browser-safe strict artifact/workflow schemas, final/live invariants, optimistic/finalization/completion rules, and exact domain-event payload/provenance bindings.
- `packages/database`: 0012 DDL, Drizzle parity, exact readiness, SHA-bound handshake, member/system/worker repositories, bounded cursors/deadlines, privacy-safe errors, test harness portability, and real-PostgreSQL lifecycle/upgrade/concurrency/immutability/completion coverage.
- `apps/api`: exact four artifact routes, v3 dashboard composition, strict errors/headers/idempotency, and dependency/auth wiring.
- `apps/worker`: independent implementation recompute handler/receipt path and strict course-completion event validation/classification.
- `apps/web`: production dashboard v3 parsing, Plan/Workflows structured editors, memory-only autosave/conflict/history/session state, accessible field errors/tabs, authoritative completion rendering, mobile shell, and production browser coverage.

## Decisions

- PostgreSQL JSONB is the structured editable authority; Blob remains reserved for later exports/attachments.
- Workspace scope is exact `(account, course)` with five stable seeded roots and one exact current pointer per root.
- A final workflow portfolio requires exactly three complete workflows; only shared completion additionally requires all three live, passed, and launched.
- The earliest personal course completion by `(completed_at,id)` satisfies the account-level lesson component. Both lessons-first and artifacts-first orders converge idempotently.
- Audit/outbox/errors/cursors never contain artifact or workflow content. Unsynced browser drafts remain memory-only.
- Dashboard v1/v2 remain frozen; v3 is negotiated explicitly and must be deployed API-first before promoting the web flag.

## Concerns and follow-up

- Task 8/0013 may consume only the frozen handshake and must preserve the explicit certificate independence assertion.
- Deployment, provider configuration, and dashboard-v3 environment promotion are deliberately outside this local-only task and require the staged production rollout.
