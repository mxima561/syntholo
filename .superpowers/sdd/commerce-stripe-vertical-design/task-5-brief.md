# Task 5 brief — signed Stripe webhook receipt and API composition

Read this first; it is the exact bounded task contract.

## Context and immutable inputs

- Baseline commit: `a66ba1017323b9d960403a8f809c66a381dcb204`.
- Binding design: `.superpowers/sdd/2026-08-13-production-program/commerce-stripe-vertical-design.md`, SHA-256 `94448c42979fe5c8674a2491d40360955aa12c606c779b850192d119cb94b8a3`.
- Binding route ADR: `docs/architecture/http-route-contract.md`, SHA-256 `9d25be1be6e02cd1adcaef812dde4e2b57b07fc7daea5ea66dcf242d6f3aa78a`.
- Published migrations `0001`–`0014` and all 14 journal rows are immutable.
- Commerce catalog migration SHA-256: `4bc124a641e6912d84fc6675133476f92e52e8fa89151079d05433d31deba8d4`; signed handshake: `packages/database/src/schema/commerce-catalog-handshake.json`, full-object SHA-256 `5f72c5f9c1f25bdfb815f3dc10fa90eccb42e33e3fa13555851da7542e9f7d27`.
- Task 1's Stripe SDK stays pinned to `22.3.2` and API version `2026-06-24.dahlia`. Its exact verifier, endpoint binding, dual-secret rotation, strict normalized envelope, and API/worker credential separation are authority inputs, not reimplemented here.

## Deliverable

Implement and locally commit the production API boundary for `POST /v1/webhooks/stripe`:

1. Add an exact raw-body route and handler that calls `verifyAndNormalizeStripeWebhook` over the untouched `Buffer`, one `stripe-signature` header, the configured current/previous endpoint secrets, the direct-account binding, and the injected UTC clock.
2. Persist every correctly signed normalized envelope through the closed `syntholo_commerce_record_provider_event_v1` system command in one short transaction, including the verifier's exact `objectTypeValid` classification. Never retain the raw body, signature, verified key ID, provider object, exception, or unrestricted payload.
3. Return exact `200 {"received":true}` after durable insertion/replay for new `received`, `processed`, or `failed_terminal` state. Correctly signed context drift, missing/wrong API version, object-type mismatch, and immutable-envelope collision are terminal evidence and return `200`.
4. Return retryable `503` with `Retry-After: 1` for an active `processing` lease, durable `failed_retryable`, transaction/deadlock/unavailable dependency, or reconciliation failure. Return `400 WEBHOOK_SIGNATURE_INVALID` with no receipt only for missing/duplicate/malformed/stale/wrong-secret/unparsable/non-raw input. No other failure may expose provider or database detail.
5. Add strict optional API configuration/composition. When disabled, no Stripe route, secret, key, or adapter is constructed and any partial `STRIPE_*` configuration fails startup. When enabled, parse the complete Task 1 API environment, require production/test mode and deployment binding, open no new database capability, compose only the existing system database UoW plus verifier/receipt boundary, and register exactly the one webhook route.
6. Preserve a narrow, typed hosted Checkout/Portal provider-action port in production composition for later tasks, but make no provider call and register no Checkout/Portal route in this task. Provider action results, URLs, and keys never enter webhook dependencies or logs.
7. Add API/system-login real-PostgreSQL evidence that the route can insert/replay exact receipts through the system capability while member/staff/worker/raw DML remain denied and startup readiness requires the frozen 0014 tuple.

The durable `received` state is the handoff to the later canonical-retrieval/fulfillment worker. This task does not claim, finish, or mutate a known paid event. Production activation remains off until the complete handler registry and rollout gates exist; acknowledging a durably queued event here does not grant access.

## Exact HTTP and safety contract

- Method/path is exactly `POST /v1/webhooks/stripe`; implicit `HEAD`, `GET`, query parameters, cookies, Clerk, WorkOS, CSRF, and alternate authorization are rejected or ignored as authority.
- The route alone enables `config.rawBody=true`; all other routes remain raw-body free. Body limit is exactly `1_048_576` bytes, and an empty/missing/non-Buffer raw body fails as signature-invalid.
- `stripe-signature` must occur exactly once in the request's raw header pairs and normalize to one nonempty string. Duplicate header occurrences/array values fail before verifier invocation; commas inside the single official Stripe signature value remain valid verifier syntax.
- Success body is exactly `{ received: true }`. Success and errors use `Cache-Control: no-store`; errors use the accepted strict envelope and canonical request correlation ID. No CORS credential behavior is added.
- Request logging remains globally disabled. Tests must prove the raw bytes, signature, endpoint secret/key ID, restricted key, Stripe URL, provider payload, email/address/token, and database/provider exception are absent from logs, errors, audit, outbox, and receipt payload.
- Correctly signed unknown event types are durably queued in this task. The later processor alone may claim them and record `processed/ignored_event_type`; the HTTP route never invents domain effects.
- The route accepts provider-created time as a bounded normalized event fact, never as signature freshness, ordering, lock, or fulfillment authority.
- Shutdown/client abort propagates through the request handler before a receipt transaction begins. Once the closed receipt command has started, it remains atomic and may durably commit; a later disconnect neither rolls it back nor converts that commit into an error claim, and no response is sent to the closed socket.

## Configuration and provider boundary

- Add an explicit disabled/enabled Commerce Stripe API mode. Disabled mode rejects any secret-bearing or authority-bearing Stripe environment variable instead of silently ignoring it.
- Enabled mode delegates to `parseStripeApiEnvironment`; it does not duplicate credential/version/URL parsing. `STRIPE_TEST_FAKE=1` remains test-only and cannot construct in production.
- API configuration contains no worker read/action key; worker configuration contains no API key or webhook secret. Web/public builds remain forbidden from every Stripe server variable.
- Endpoint binding remains direct-account v1: exact receiver account, exact livemode, exact API version, and null event account/context. No Connect or organization fallback.
- No catalog attestation, Checkout creation, Portal creation, canonical retrieval, refund/cancel/action execution, provider mutation, endpoint creation, or live/test Stripe call is authorized by this task.

## TDD and evidence contract

1. Capture focused RED before production code: the Stripe webhook module/route/composition is absent and exact route requests return 404.
2. Handler tests cover exact raw-byte verifier input, secret rotation, accepted/terminal classifications, nullable observed API version, strict object-validity propagation, duplicate state mapping, abort/deadline, and safe error classification.
3. Route tests cover valid 200, exact response shape, one signature header, raw body/1 MiB bound, malformed JSON/signature/body mutation/stale signature, HEAD/GET/query rejection, retryable 503 + `Retry-After`, correlation/no-store headers, no auth fallback, and ordinary routes remaining raw-body free.
4. Composition/config tests cover complete enabled/disabled states, partial/foreign worker configuration rejection, fake-production denial, exact verifier/UoW wiring, no secret values in `ApiDependencies`, no provider call at startup, and close ordering.
5. Real PostgreSQL covers fresh insert, exact replay, signed nullable-version terminal, signed object-mismatch terminal, immutable-envelope collision, processing/retryable mapping, database rollback/unavailability, system capability allow/deny, and exact receipt/attempt/payload nonleakage.
6. Run full affected unit, API integration, root lint/typecheck, production API build/syntax/artifact/secret scans, `git diff --check`, and a disposable Neon route/database gate if production composition changes database behavior. Delete every disposable branch.

## Owned files

Primary ownership is limited to additive Stripe webhook API modules/routes/tests and exact API configuration/composition registrations:

- `apps/api/src/modules/stripe-webhook.ts` and tests
- `apps/api/src/routes/webhooks/stripe.ts` and tests
- `apps/api/src/app.ts` and app tests for the optional route dependency
- `apps/api/src/config.ts` and config tests
- `apps/api/src/server.ts` and server/composition tests
- a narrow database-backed webhook repository adapter under `apps/api/src/modules/` or `packages/database/src/repositories/`, with tests, only if needed to preserve the system UoW boundary
- this ledger, `task-5-report.md`, and mechanically necessary package/export fixtures

Do not edit `0014_commerce_catalog.sql` or any earlier migration. Do not edit web UI, worker event handlers, entitlement commands, paid fulfillment, claims/onboarding, applications, cases, refunds, disputes, reconciliation, or provider-action execution.

## Report and commit contract

Write `.superpowers/sdd/commerce-stripe-vertical-design/task-5-report.md` with RED/GREEN evidence, exact route/config/repository behavior, database and production-build results, changed files, decisions, nonleakage scan, activation state, and concerns. Commit locally only after green and independent review. Do not push, deploy, configure a Stripe endpoint, call Stripe, or mutate Neon/Railway/Vercel production state.
