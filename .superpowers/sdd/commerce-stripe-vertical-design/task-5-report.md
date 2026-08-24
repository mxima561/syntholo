# Task 5 report — signed Stripe webhook receipt and API composition

Date: 2026-08-15

## Outcome

Task 5 adds the production API boundary for exactly `POST /v1/webhooks/stripe`. The route verifies the untouched request `Buffer` with the pinned Task 1 verifier, direct-account binding, and current/previous endpoint-secret rotation; it persists only the normalized envelope and trusted object-validity classification through the existing attested system UoW and `syntholo_commerce_record_provider_event_v1`. Correctly signed durable or terminal evidence returns exact `200 {"received":true}`. Active processing, durable retryable state, dependency failure, and reconciliation failure return safe `503` plus `Retry-After: 1`; signature/raw-input failures return safe `400 WEBHOOK_SIGNATURE_INVALID` without a receipt, while forbidden query input returns the existing strict query error.

Stripe API composition is explicitly disabled by default. Disabled mode constructs no Stripe adapter or route and rejects partial/foreign `STRIPE_*` environment. Enabled mode delegates to the pinned Task 1 parser, requires deployment binding, keeps worker credentials forbidden, and composes the narrow hosted Checkout/Portal port without invoking it. No Stripe request, endpoint configuration, provider object, deployment, production database mutation, push, or external provider mutation occurred.

## RED evidence

- Initial focused handler/route RED: 3/3 failed before production edits—the handler module was absent, exact signed POST returned 404, and enabled Stripe dependencies were rejected because the composition schema did not exist.
- Configuration RED: 2/2 failed because disabled/enabled Stripe API state was absent, so partial-config rejection and exact Task 1 parsing could not pass.
- Real HTTP duplicate-header RED exposed a test-harness limitation: injection collapsed a header array. The final proof uses a raw TCP request with two physical `Stripe-Signature` lines and verifies rejection before the handler.
- The first disposable-Neon run corrected two fixture assumptions against published 0014 authority: missing observed API version terminalizes as `security_context_mismatch`, and worker claim commands require exact system actor context. No production SQL changed.
- Signed immutable-envelope collision evidence confirmed the binding contract: 0014 atomically terminalizes it as `security_envelope_mismatch` and the API returns 200 to prevent unbounded provider redelivery; it does not create a second receipt.
- The complete API integration run exposed an older dashboard test helper deleting Neon TLS query parameters when substituting a runtime login. Preserving the safe transport query fixed the actual `connection is insecure` root cause; isolated dashboard 5/5 and the full API integration suite then passed.

## GREEN evidence

- Focused Stripe handler/route/config tests: 67/67 passing, including official current/previous secret verification, nullable version and object mismatch, malformed signed JSON, stale signature, body mutation, duplicate physical signature headers, 1 MiB bound, exact route closure, safe mappings, no provider call, and client-disconnect cancellation.
- Dedicated real-PostgreSQL webhook suite: 4/4 passing through a real `syntholo_system_api` login. It covers fresh insert, exact replay, raw-table denial, nullable-version/object-mismatch terminal evidence, live processing lease, durable retryable state, immutable-envelope collision, one-receipt convergence, and minimized payload nonleakage.
- Full API PostgreSQL integration: 3 files, 14/14 passing over explicit TLS verification.
- Full API unit: 13 files, 222/222 passing. API typecheck and lint pass.
- Root unit gate: API 222, Web 206, Worker 93, Contracts 78, Database 347, Domain 239, Integrations 99, Testing 110 — 1,394 passing in total.
- Root typecheck and lint: every workspace passing. `git diff --check` passes.
- Production API build succeeds with an explicit immutable release SHA; `apps/api/dist/server.js` passes `node --check`.
- Precise source/artifact scan finds no literal Stripe webhook/restricted/secret key, database credential URI, raw provider body fixture, or temporary artifact. Request logging remains globally disabled.
- Disposable Neon branch `br-flat-poetry-auw9gwz4` was used only for the API/system-login tests and deleted after the green run.

## Exact HTTP and persistence behavior

- Registered surface: only `POST /v1/webhooks/stripe`; GET, implicit HEAD, and query parameters are rejected. The route is unconnected to Clerk, Cloudflare Access, cookies, CSRF, member, or staff authorization.
- The route alone requests raw-body capture and installs a scoped JSON buffer parser. The exact body limit is 1,048,576 bytes. Empty, missing, oversized, non-Buffer, malformed, stale, mutated, wrong-secret, or duplicate-header input is signature-invalid.
- Request abort/response close reaches the handler before a receipt transaction starts. Once the closed database command begins, it remains atomic; a disconnect does not roll back or misreport a durable commit.
- Stored authority is limited to event/object IDs and types, livemode, nullable observed API version, millisecond provider time, receiver/account/context binding, raw-body SHA-256, status, and empty payload. Raw bytes, signature, matched key ID, endpoint secrets, restricted key, provider object, URL, email/address/token, and exception detail are not persisted or returned.
- The record adapter uses only an attested `SystemDatabase`, system actor `commerce-webhook.v1`, null account scope, canonical request correlation, and the existing transaction-bound Commerce repository.

## Configuration and composition

- `STRIPE_COMMERCE_ENABLED` defaults to `false`. Any other defined `STRIPE_*` variable while disabled fails startup.
- Enabled mode calls `parseStripeApiEnvironment` with the real Node environment, requires an explicit deployment environment, denies test-fake credentials in production, and denies live-mode binding outside production.
- The API composition owns only the API restricted key and webhook secrets. Task 1 rejects worker read/action credentials in this environment.
- The hosted Checkout/Portal adapter is retained only as two typed functions in the enabled dependency closure. Startup and webhook requests never call either function, and Task 5 registers no Checkout or Portal route.
- Startup attests the system database before creating the receipt port; the frozen 0014 readiness/journal authority remains required through the existing database readiness path.

## Changed areas

- `apps/api/src/modules/stripe-webhook.ts`: official verifier-to-closed-receipt handler and attested system-UoW adapter.
- `apps/api/src/routes/webhooks/stripe.ts`: exact raw-body POST route, strict header/body/query boundary, cancellation, and safe response mapping.
- `apps/api/src/app.ts`, `config.ts`, and `server.ts`: optional disabled/enabled dependency schema, strict Task 1 environment parsing, provider port closure, and production wiring.
- `apps/api/src/plugins/error-handler.ts`: route-specific safe oversized/unsupported-media signature-invalid mapping.
- Stripe unit/route/integration tests: exact wire, verifier, composition, cancellation, nonleakage, and real-system-login evidence.
- `apps/api/src/modules/member/dashboard.integration.test.ts`: mechanically necessary preservation of Neon TLS query parameters when creating the isolated member login.

## Decisions

- Correctly signed context/object/envelope mismatch is durable terminal evidence and returns 200; it is not treated as unsigned input and is not retried forever.
- Unknown signed event types remain `received` for a later closed processor. The webhook route creates no purchase, entitlement, claim, enrollment, or other domain effect.
- The API does not interpret Stripe success, call canonical provider retrieval, or invoke hosted Checkout/Portal actions. Those belong to later tasks with their own fences and provider evidence.
- Production activation remains an external rollout decision and stays off by default. Shipping this code does not enable paid offers or configure a Stripe endpoint.

## Concerns and follow-up

- Task 6 must add the canonical-retrieval/fulfillment worker registry before webhook activation; a durable `received` receipt is only the handoff.
- Later Checkout/Portal tasks must preserve the narrow provider port and add their own authorization/idempotency/provider-action evidence rather than broadening the webhook dependency.
- Live/test Stripe endpoint creation, secret installation/rotation, provider calls, and production activation remain explicitly pending for the final rollout task.
