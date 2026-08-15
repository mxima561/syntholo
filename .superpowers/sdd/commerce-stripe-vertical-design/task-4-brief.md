# Task 4 brief — 0014 Commerce catalog and durable purchase authority

Read this first; it is the exact bounded task contract.

## Context and immutable inputs

- Baseline commit: `af6a7db7272fde9f608c5b3568475b358d698629`.
- Binding design: `.superpowers/sdd/2026-08-13-production-program/commerce-stripe-vertical-design.md`, SHA-256 `94448c42979fe5c8674a2491d40360955aa12c606c779b850192d119cb94b8a3`.
- Binding amended route ADR: `docs/architecture/http-route-contract.md`, SHA-256 `9d25be1be6e02cd1adcaef812dde4e2b57b07fc7daea5ea66dcf242d6f3aa78a`.
- Published migrations `0001`–`0013` and all 13 journal rows are immutable.
- Upstream implementation migration SHA-256: `dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9`; signed handshake: `packages/database/src/schema/implementation-handshake.json`.
- Upstream certificate migration SHA-256: `878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9`; signed handshake: `packages/database/src/schema/certificates-handshake.json`.
- Certificate issuance is earned-history authority and remains independent of Commerce, entitlement, refund, dispute, subscription, seat, support, Circle, and Business OS state.

## Deliverable

Append and locally freeze `0014_commerce_catalog.sql` plus its exact Drizzle schema mirror, repositories, readiness projection, signed handshake, and real-PostgreSQL behavior/race evidence.

The migration owns:

1. Exact six-offer catalog authority: `offers`, immutable/versioned catalog publications, and environment-bound Product/Price/tax bindings for Self-Paced, Guided Pilot, Operator Club monthly/annual, and the separate Business OS setup/monthly prices. Scorecard is free and has no Price binding.
2. Durable Checkout authority: authorizations, Sessions, provider-create actions, stable integration/idempotency identity, exact catalog/policy/content binding, one-Session/provider-object ownership, expiry, and signed-event-only fulfillment state.
3. Two-stage Business OS authority: public pre-account encrypted/HMAC intent with no account before signed paid fulfillment; existing-account setup epochs; Customer creation ownership; recurring-family singleton intents; separate setup and recurring financial identities; retention/hold/terminalization facts.
4. Normalized financial roots: Stripe customers, purchases and payment allocations, subscriptions/schedules, invoices and invoice allocations, and the controlled Gate 5 authorization topology. These are immutable money/provider facts, not browser/provider-response authority.
5. Claims and onboarding: hashed claim-token generations, fragment-cookie pending sessions, secure-link delivery facts, account onboarding/priorities, and canonical provisional/confirmed account-name state. No raw token, email, URL, provider payload, or secret enters audit/outbox/jobs/loggable JSON.
6. Provider receipt hardening: immutable typed envelope/digest on the published receipt root, endpoint/account/context binding, fenced processing/attempt history, domain-effect idempotency, terminal-vs-retryable outcomes, and empty raw provider payload retention.
7. Closed atomic repository/functions that record paid financial state, consume claims, establish pinned learning access/enrollment/owner-seat state, seed the Task 7 workspace, and call only the accepted Task 8 entitlement commands. Redirects, client input, Session status alone, and unsigned provider facts never grant.
8. The exact four-kind Business OS reconciliation extension and closed public setup adapter described by the binding design, reusing the existing Task 8 outbox type/filter. No fifth incident kind or second entitlement state machine.
9. Five-role ACL/RLS/immutability/readiness inventory, upstream composite-key attestation, exact runtime-function allowlists, and startup `checkDatabaseReadiness` composition for the signed 0014 tuple.
10. A fail-closed, PUBLIC-revoked, ungranted placeholder for `syntholo_cleanup_public_bos_intents_v1`. It must not delete or be executable by `syntholo_worker` until 0016 adds the complete refund/dispute/pending-effect predicates and deliberately activates the audited worker-only routine.

## Explicit exclusions

- No Stripe network call, webhook HTTP route, API route, browser UI, provider configuration, secret, deploy, push, or production/test-provider mutation.
- No scorecard/Pilot/cohort/application tables from `0015_applications.sql`.
- No cases, refunds, disputes, pending provider effects, refund preparations, or provider-action execution from `0016_commerce_cases.sql`.
- No activation of public Checkout, Business OS Checkout, Gate 5, or cleanup.
- No certificate mutation or dependency from Commerce into `certificate_*` tables/functions.
- No edits to migrations `0001`–`0013`; forward replacement is allowed only where the binding design explicitly requires exact runtime/readiness/Task 8 extension composition, and every replacement body must be hash-attested.

## Exact authority and safety rules

- USD integer minor units only. Ordinary catalog values are exactly: Self-Paced 39900 once, Guided Pilot 75000 once, Club monthly 5900/month, Club annual 59000/year, Business OS setup 99900 once, Business OS recurring 19900/month.
- Persist only an attested binding fingerprint and non-secret provider IDs. The browser never supplies Price, Product, amount, account, Customer, tax, discount, or livemode authority.
- Every customer-owned row carries immutable `account_id`; public pre-account Business OS intent rows are the only deliberate exception and must never authorize account/member reads before signed paid fulfillment.
- Public Business OS uniqueness is keyed by approved purpose-separated purchaser-guard and semantic-command HMAC key versions. Never use plain email hash or attach an existing account by email.
- Account recurring/setup reservation happens before provider work under exact account/family locks and partial unique indexes. Ambiguous provider results reconcile by stable action identity; retries never blindly create.
- Existing Task 8 entitlement commands remain sole grant/reversal authority. 0014 may add only the bounded public Business OS adapter/reconciliation extension specified by the design.
- Signed paid provider events are sole payment authority. Redirects, API successes, Checkout completion without qualifying payment, and out-of-band invoices never grant.
- Exact composite FKs bind account/source/provider/receipt/job/claim/onboarding ownership; no UUID-only cross-account relationship.
- Append-only/immutable money, provider, policy, and receipt facts; state changes occur only through hash-attested closed functions with deterministic lock order and command/receipt replay semantics.
- Member/staff/runtime roles get no raw commerce DML. PUBLIC execute is denied. The cleanup placeholder has no runtime execute grant.
- Readiness attests exact columns/defaults/collations/checks/FKs/uniques/indexes/triggers/RLS/policies/table and column ACLs/function metadata+bodies+ACLs, runtime allowlists, upstream readiness/hashes, cleanup disabled state, empty/demo-free catalog policy, and the exact 0014 journal tuple/hash.

## TDD and evidence contract

1. Capture focused RED before production schema/SQL: strict catalog/authority schema module and `0014_commerce_catalog.sql` absent while all frozen upstream hashes pass.
2. Build Drizzle schema GREEN before migration SQL, with exact table/column/check/key/index inventory tests.
3. Build migration and readiness RED→GREEN one authority boundary at a time. Recompute every expected function body from source; never hand-wave hashes or weaken comparisons by lowercasing literals/ignoring array bounds/omitting ACL dimensions.
4. Real PostgreSQL must cover blank/prior/populated/repeat migration, exact 14-row journal and startup readiness, real member/staff/system/worker login denial/allowance, catalog publication/attestation, Checkout/account/BOS singleton races, provider-action replay/ambiguity, signed-paid-only fulfillment, claim/enrollment/owner-seat/workspace convergence, onboarding replay, provider receipt lease/crash/duplicate/terminal behavior, public-intent retention/hold boundaries, and certificate non-revocation.
5. Hostile readiness mutations must independently flip and restore the relevant flag for structure/FK/index/trigger/RLS/policy/table+column ACL/function body+metadata+ACL/runtime allowlist/upstream hash/journal/cleanup-disabled/catalog independence drift.
6. Add a SHA-bound `commerce-catalog-handshake.json` covering migration tuple/hash, catalog keys and exact ordinary values, provider/customer/purchase/session/action composite ownership, claim/onboarding keys, receipt/processing/effect keys, Task 8 and learning command signatures, events/jobs, cleanup disabled state, certificate non-authority, and downstream 0015/0016 consumer keys.
7. Run affected full unit, lint, typecheck, migration/static import/secret checks, `git diff --check`, disposable Neon migration/readiness/behavior/schema checks, and an independent read-only review before freeze.

## Owned files

Primary ownership is limited to additive Commerce schema/migration/readiness/repository/test/report files plus exact append-only registrations in:

- `packages/database/drizzle/0014_commerce_catalog.sql`
- `packages/database/drizzle/meta/_journal.json`
- `packages/database/src/schema/commerce.ts` and exports/tests
- `packages/database/src/commerce-catalog-migration.test.ts`
- `packages/database/src/commerce-catalog-readiness.test.ts`
- `packages/database/src/commerce-catalog.integration.test.ts`
- `packages/database/src/repositories/commerce.ts` and tests
- `packages/database/src/schema/commerce-catalog-handshake.json` and test
- `packages/database/src/migrations.ts`, `readiness.ts`, client/runtime allowlist parity and their tests
- this ledger, `task-4-report.md`, and mechanically necessary schema-count/foundation fixtures

Do not edit API/web/worker/integrations production composition in this task.

## Report and commit contract

Write `.superpowers/sdd/commerce-stripe-vertical-design/task-4-report.md` with RED/GREEN evidence, frozen tuple/hash, signed handshake, catalog authority, exact ACL/readiness/real-PG/race results, changed files, decisions, secret scan, and concerns. Commit locally only after green and independent review. Do not push, deploy, or mutate Stripe/Neon/Railway/Vercel production state. Disposable Neon branches are allowed only for the migration test gate and must be deleted afterward.
