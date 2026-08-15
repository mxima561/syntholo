# Task 4 report — Commerce catalog and durable purchase authority

Date: 2026-08-15

## Outcome

Task 4 appends the local database authority for the six-offer Commerce catalog, durable Checkout/provider actions, signed-event purchase fulfillment, two-stage Business OS setup, normalized provider/financial roots, account claims, onboarding, and fenced provider receipt processing. Paid offers remain paused by default, the public-intent cleanup function remains deliberately ungranted and fail-closed until 0016, and certificate issuance remains independent. No Stripe network call, provider configuration, production database, deployment, push, or external provider mutation occurred.

## RED evidence

- Initial schema/migration RED froze the exact 27-table Commerce topology, composite ownership keys, immutable provider/financial facts, one-live-family indexes, RLS/ACL closure, runtime allowlist, upstream hashes, and cleanup-disabled boundary before `0014_commerce_catalog.sql` existed.
- PostgreSQL migration RED exposed the populated-account deferred owner invariant during the `name_status` backfill, PostgreSQL 18 CHECK deparse spelling, the generated 63-byte constraint-name boundary, and missing-journal readiness returning a partial row. Each received a bounded regression before the candidate hash moved.
- Cross-domain RLS RED exposed a real member capability regression: 0014 added `accounts.name_status` without extending the published member column-update grant. The migration now grants exactly `UPDATE(name,name_status,updated_at)` on `accounts`; Task 4 tables remain function-only.
- The new full paid-flow RED exposed two real PL/pgSQL identifier collisions in `syntholo_commerce_redeem_claim_v1`: the output `membership_id` versus the enrollment column, and the output `account_id` versus `ON CONFLICT(account_id)`. Distinct resolved locals plus the named onboarding primary-key constraint close both paths.
- Task 5 webhook preflight exposed a signed-envelope mismatch: Task 1 deliberately preserves a missing Stripe API version for durable terminal classification, while the first 0014 candidate rejected `NULL` before receipt insertion. The final repository/schema/function accept the nullable observed version, compare it with the non-null pinned expected version, and persist exactly one `failed_terminal/security_context_mismatch` receipt.
- The same webhook preflight proved that the verified adapter's signed event/object mismatch had no exact database input. The final receipt command carries a strict `eventObjectValid` bit from the trusted verifier and atomically records `failed_terminal/event_object_mismatch`; it never substitutes that bit for the independent receiver, mode, API-version, account, or context checks.
- Real-login/behavior RED covered member/staff/worker raw-DML denial, catalog staging races, provider-event duplicate/lease/reclaim/fenced acknowledgment, signed-paid-only fulfillment, claim replay, owner establishment, onboarding validation/completion, and exact downstream convergence.

## GREEN evidence

- Root unit gate: API 212, Web 206, Worker 93, Contracts 78, Database 347, Domain 239, Integrations 99, Testing 110 — 1,384 passing in total.
- Root typecheck and lint: every workspace passing. `git diff --check` passes.
- Focused migration/readiness/handshake/startup gate: 106/106 passing. Full database unit: 347/347. Testing package: 110/110.
- Focused PostgreSQL RLS gate: 21 passing, 4 explicit skips, 0 failed.
- Dedicated Commerce PostgreSQL gate: 10/10 passing. It covers blank/prior/populated/replay migration, unsafe legacy Stripe fail-closed behavior, exact startup/readiness, real role denial/allowance, hostile readiness drift, concurrent catalog staging, provider receipt fencing, and the complete signed-paid claim/onboarding path.
- Final full disposable Neon database sweep: 12 files, 235 passed, 6 explicit skips, 0 failed in 605.38 seconds.
- Final direct disposable-Neon readiness query on the exact candidate reports all booleans true, `cleanup_disabled=true`, `implementation_completion_is_authority=false`, exact upstream hashes, 98 public tables, and 14 journal rows.
- `npm run db:schema:check` passes and exports the 98-table Drizzle schema, including all 27 Commerce tables and exact composite foreign keys/indexes.
- Secret-pattern scan found only explicit `.example`, `.example.test`, and localhost credential fixtures. No material database/provider credential, private key, webhook secret, or provider URL is present.

## Migration and signed handshake

- Tuple: journal index `13`, timestamp `1787029200000`, tag `0014_commerce_catalog`.
- SHA-256: `4bc124a641e6912d84fc6675133476f92e52e8fa89151079d05433d31deba8d4`.
- Upstream implementation authority: frozen 0012 SHA-256 `dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9`.
- Certificate non-authority: frozen 0013 SHA-256 `878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9`, with `implementationCompletionIsAuthority: false` preserved.
- Handshake fixture: `packages/database/src/schema/commerce-catalog-handshake.json`; full-object fixture SHA-256 `5f72c5f9c1f25bdfb815f3dc10fa90eccb42e33e3fa13555851da7542e9f7d27`.
- The handshake freezes exact catalog values/keys, provider/account/session/action ownership, purchase/subscription/invoice roots, claim/onboarding keys, provider receipt/attempt/effect identity, learning/entitlement command dependencies, events/jobs, cleanup-disabled state, certificate independence, and downstream 0015/0016 consumer keys.

## Paid-flow convergence proof

The real-PG paid-flow test builds an exact approved 18-lesson course, stages and publishes a test-only Self-Paced binding, and enables the otherwise-paused offer only inside its isolated disposable database. It then uses the real `syntholo_system_api` and `syntholo_member_api` logins and closed functions to prove:

- redirect/session state alone grants nothing; the qualifying signed provider receipt and live lease fence are required;
- one paid purchase produces exactly three active Self-Paced grants, one pinned course access, one owner seat, one active enrollment, and five implementation roots;
- the claim token/session is replay-safe and establishes one owner identity/membership without attaching by email;
- onboarding saves under optimistic version authority, completes exactly once with an actor-bound receipt, confirms the provisional account name, and emits one `onboarding.completed.v1` event.

## Major implementation areas

- `packages/database/src/schema`: exact Commerce Drizzle tables, checks, composite FKs, uniques, indexes, account-name state, provider receipt envelope, and exports/tests.
- `packages/database/drizzle/0014_commerce_catalog.sql`: paused six-offer seed, immutable catalog/provider/financial authority, closed Checkout/purchase/claim/onboarding/receipt functions, RLS/ACL closure, forward runtime/readiness composition, and cleanup placeholder.
- `packages/database/src/repositories`: strict transaction-bound Commerce commands and the mechanically necessary account/entitlement/unit-of-work extensions.
- `packages/database/src/readiness.ts`: exact signed 0014 startup projection composed with frozen 0012/0013 authority and certificate non-authority.
- `packages/database/src/commerce-catalog.integration.test.ts`: isolated upgrades, real role logins, hostile drift/races, provider fences, and signed-paid convergence.
- `packages/testing/src/database.ts`: Commerce-aware deterministic cleanup plus a complete typed Stripe receipt fixture.

## Decisions

- All paid offers remain `paused` after migration. Catalog publication and provider identifiers are durable database authority, but public Checkout activation belongs to later rollout work.
- Signed paid provider events are the only payment authority. Browser redirects, API success, Checkout status alone, or unsigned provider facts cannot grant.
- Task 8 entitlement commands remain the sole grant/reversal authority; 0014 records provider/financial facts and calls the closed accepted commands rather than creating a second entitlement state machine.
- Public Business OS pre-account intent is the only account-less purchase path. It stores purpose-separated encrypted/HMAC facts and never attaches an existing account by email.
- `syntholo_cleanup_public_bos_intents_v1` remains PUBLIC-revoked and ungranted to every runtime role. 0016 must add the complete hold/refund/dispute predicates before deliberate activation.
- Commerce does not read, write, revoke, or gate `certificate_*` authority. Implementation completion remains non-authoritative for both certificates and Commerce.

## Concerns and follow-up

- Stripe provider calls, webhook HTTP ingestion, API/web/worker composition, secrets/configuration, and public Checkout activation are deliberately outside Task 4 and remain for later tasks.
- Cleanup remains deliberately disabled until 0016 implements the complete retention and recovery policy.
- Paid-flow activation was exercised only in an isolated disposable PostgreSQL database; the committed catalog remains paused and no provider object was created.
