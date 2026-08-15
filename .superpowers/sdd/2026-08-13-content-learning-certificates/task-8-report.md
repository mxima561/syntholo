# Task 8 report — private certificates of completion

Date: 2026-08-15

## Outcome

Task 8 implements the local private, unaccredited certificate flow end to end: actor-bound recipient names, immutable personal certificate records, deterministic PDFs, a private Vercel Blob integration boundary, exact member and staff APIs, certificate-capable worker rollout/recovery fences, member certificate settings, and honest staff delivery-recovery requests. Certificate eligibility depends only on the frozen personal 0011 completion authority; the 0012 implementation workspace remains explicitly non-authoritative. No provider production state was mutated and nothing was pushed or deployed.

## RED evidence

- Contract/domain RED froze canonical Unicode recipient-name ingress, the exact two-font repertoire manifest, renderable versus safely redacted snapshots, impossible status/failure combinations, int4 bounds, and terminal/retryable lifecycle rules before schema work.
- PDF/Blob RED exposed incompatible Unifont OTF assets in the pinned renderer, deployed asset-path drift, missing glyph authority, nominal `Headers` incompatibility with the pinned Blob SDK, quoted ETag drift, unbounded/hung operations, abort/cancel ordering, late stream leakage, environment/store confusion, and ambiguous upload recovery.
- Migration/static RED covered exact composite ownership and snapshot FKs, one-time name binding, immutable status/file/delivery transitions, job and receipt provenance, authorization-before-replay, direct-job capability rollout, bounded historical promotion, storage-failure recovery, runtime capability mirrors, and exact catalog readiness.
- Disposable PostgreSQL/Neon RED exposed PL/pgSQL composite `SELECT INTO` incompatibility, PostgreSQL 18 CHECK deparse spelling/case, and the 63-byte generated FK-name truncation. Each received a bounded regression before the candidate hash moved.
- API/web RED covered strict five-route contracts, private streamed download cancellation before and after headers, Clerk session isolation, byte-identical name retries, sticky conflicts, stale polling responses, awaiting-to-pending-to-issued refresh, mobile navigation, accessible status/error output, and honest staff pending delivery.
- Worker RED covered complete live job fences, storage-failure dead-letter semantics, crash-after-finalize/mark-failed acknowledgement, post-render revalidation, ambiguous object reconciliation, bounded operation deadlines, recurring promotion, startup asset authority, and generation-scoped recovery decisions.

## GREEN evidence

- Root unit: API 212, Web 206, Worker 93, Contracts 78, Database 269, Domain 239, Integrations 99, Testing 110 — 1,306 passing in total.
- CI-form workspace coverage gate: passing across every workspace with JSON, text, and JUnit reporters.
- Root lint and typecheck: all workspaces passing with no warnings.
- Root production build: API, Next.js 16 web, worker, certificate renderer, and migration artifacts passing with release-bound production fixture configuration. Node syntax checks pass for API, worker runner/cron/certificate renderer, and migrator artifacts.
- Production web artifact/demo/secret scan: passing; production learn payloads and referenced client chunks contain no demo modules, fixture member data, credentials, or private keys.
- Production Playwright: 10/10 passing. Certificate evidence includes canonical member name confirmation, visible awaiting-to-pending-to-issued progression, exactly one bearer-only private PDF download, five 44px mobile links, no horizontal overflow, WCAG 2 A/AA axe checks, authorized staff delivery recovery, truthful `delivery_pending` copy, and no demo/live-status/destination leakage.
- Demo Playwright regression suite: 63 passing and 17 explicit viewport skips. The three intentional shell/navigation baselines were visually inspected and regenerated for truthful admin-session copy and the fifth member Certificates link.
- Focused certificate production Playwright: 3/3 passing. Focused staff UI/route gate: 13/13. Focused worker runner: 54/54, including the real certificate handler composed through `runWorker` from `storage_failed` to durable dead-letter and exact same-job recovery authorization.
- Focused certificate migration/readiness/handshake static gate: 71/71. Full database unit suite: 269/269. `git diff --check` passes.
- Disposable Neon certificate integration on exact `878a75…`: 45/45 passing, including blank and populated 0012 upgrades, replay, all readiness flags, authorization/receipt races, immutable transitions, job capability fencing, hostile catalog drift, storage recovery decisions, concurrency, and nonrevocation/independence matrices.
- Final full disposable Neon database sweep on exact `878a75…`: 11 files, 225 passed, 6 explicit skips, 0 failed in 437.09 seconds. The run covers the certificate suite together with all prior database authorities and confirms cross-suite cleanup/order behavior.
- Final `npm run db:schema:check` against the direct disposable Neon URL passes and exports the exact 71-table schema, including the five certificate tables and their composite foreign keys/indexes.
- Authorized real-provider private Blob gate: not run because no disposable provider authorization was supplied. Injected provider-port tests are green; production provider state was not accessed or mutated.

## Migration and signed handshake

- Tuple: journal index `12`, timestamp `1786942800000`, tag `0013_certificates`.
- SHA-256: `878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9`.
- Upstream learning authority: frozen 0011 SHA-256 `2e37ec9d4bfeee1ad0319ae81172fac4107a87c798bd2f0eed79eb75ee0e2ccf`.
- Implementation non-authority: frozen 0012 SHA-256 `dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9`, with `implementationCompletionIsAuthority: false`.
- Handshake fixture: `packages/database/src/schema/certificates-handshake.json` with an exact full-object/DDL/hash test in `certificates-handshake.test.ts`.
- The handshake freezes recipient head/version/actor keys, completion/prerequisite/course-version/name-snapshot certificate FKs, file and delivery keys, direct job type/key/priority/attempts, deterministic private pathname, renderer version, statuses/failures, five API routes, and the exact 0027 pending-delivery consumer shape.
- Readiness attests the exact 13-row journal, schema/catalog/ACL/function authority, frozen font-manifest hash, forward runtime/claim functions, relevant 0011 authority, every 0012 readiness flag, and certificate independence from implementation/commerce/entitlement state.

## Major implementation areas

- `packages/contracts` and `packages/domain`: browser-safe name canonicalization, frozen glyph repertoire, strict certificate/list/name/delivery schemas, renderability rules, and lifecycle/retry authority.
- `packages/database`: 0013 DDL, Drizzle parity, exact readiness/runtime attestation, SHA-bound handshake, member/staff/worker repositories, bounded cursors/deadlines, safe recovery facts, and real-PostgreSQL upgrade/behavior/concurrency/hostile-readiness coverage.
- `packages/integrations`: environment-bound private Blob upload/get/reconcile ports with exact origin/path/MIME/hash/length/strong-ETag checks, bounded operations, cancellation, and no provider URL/token exposure.
- `apps/worker`: deterministic Unicode PDF renderer with pinned licensed fonts and manifest, built-artifact authority preflight, certificate-capable claim fence, recurring bounded promoter/recovery pumps, crash-safe generation acknowledgements, and durable same-job retry.
- `apps/api`: exact member name/list/download and staff delivery routes, membership/staff authorization before replay, strict safe errors/headers, private streamed PDF cancellation, and deployment/store configuration binding.
- `apps/web`: session-isolated certificate settings, memory-only optimistic name intent/conflict recovery, bounded authoritative status refresh, private one-shot download, five-link accessible mobile shell, truthful staff recovery UI, and production browser coverage.

## Decisions

- Certificates are immutable personal completion records. Purchases, refunds, disputes, subscriptions, entitlements, seats, support, Circle, Business OS, and shared implementation completion cannot create, revoke, rename, or gate them.
- Recipient names are explicitly confirmed, canonicalized, versioned, and actor-bound. No email/account/Clerk/demo field is inferred as a certificate name.
- PDF objects are private and deterministic at `certificates/v1/{accountId}/{courseCompletionId}.pdf`; no provider URL, public lookup, certificate number, QR code, or verification surface exists.
- Private downloads stream through the authenticated API with exact metadata/body verification and cancellation. No private Blob presigned/public GET contract is assumed.
- Staff delivery in 0013 records only an audited `delivery_pending` fact. It accepts no destination and does not send email; frozen 0027 owns any later notification delivery.
- Rollout order is exact: apply 0013; deploy the new worker fleet inactive/unsuffixed; activate validated Blob configuration and certificate-capable suffix fleet-wide; only then enable recipient-name confirmation/API enqueue.
- Storage recovery preserves the same bounded job and attempt history, authorizes at most once per failed generation, accepts only absent or exact deterministic objects, and durably suppresses mismatches without repeated provider work.

## Concerns and follow-up

- The real private Blob provider gate remains explicitly pending until disposable provider credentials/state are authorized. Injected provider-port tests do not claim anonymous-provider denial against a live store.
- Deployment, Blob environment activation, name-API enablement, email delivery, public verification, and provider production mutation are deliberately outside this local-only task.
