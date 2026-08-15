# Task 1 report — Commerce contracts, pure rules, and Stripe adapter

## Status

Complete. This task changes only provider-independent contracts/rules, the Stripe integration boundary, server configuration policy, and test-only composition. It adds no migration, repository, API route, UI, provider object/configuration, secret, push, or deploy.

Binding design: `.superpowers/sdd/2026-08-13-production-program/commerce-stripe-vertical-design.md`, verified SHA-256 `94448c42979fe5c8674a2491d40360955aa12c606c779b850192d119cb94b8a3`.

## TDD evidence

RED was captured before production implementation:

- contracts: 9 tests, 4 expected failures for missing strict commerce schemas/exports;
- domain: 7 tests, 4 expected failures for missing catalog/fingerprint/reducer rules;
- integrations: both new suites failed to load because the Stripe adapter/config modules were absent;
- web: 47 tests, 6 expected failures for newly forbidden Stripe server authorities;
- testing: 94 existing tests passed while the missing reusable Stripe fake/policy test failed.

The RED contracts were then strengthened before GREEN for exact Dahlia object shapes, dual webhook-secret rotation, canonical retrieval completeness, key/livemode binding, test-only isolation, exact Task 8 command semantics, and adversarial runtime inputs.

Final focused GREEN:

- commerce contracts: 10/10;
- commerce domain: 8/8;
- Stripe adapter/config: 35/35;
- deterministic fake and foundation dependency policy: 97/97.

## Implemented surface

### `@syntholo/contracts`

- Strict public/member selection, safe offer, pending, claim, and onboarding schemas.
- No browser Price, amount, Stripe account, Customer, tax, or provider authority.
- Strict metadata coherence for Pilot, one-time, recurring Club, and staged Business OS.
- Stable Commerce error codes.
- Strict safe event envelope and discriminated canonical object schemas for Checkout Session, SetupIntent/attached PaymentMethod proof, Invoice/payment references/lines/tax, Subscription items, Schedule, Refund, PaymentIntent, Charge, and Dispute.
- Correctly signed missing/wrong API versions remain representable for durable terminal normalization.

### `@syntholo/domain`

- Exact six-binding USD catalog validation, Stripe Product tax-code shape, catalog fingerprints, UTC-ms intervals, and adversarial scalar/runtime validation.
- Scorecard remains independent of paid catalog attestation and commerce holds.
- Offer-specific availability gates fail closed for unknown offers.
- Ordinary paid-event classification emits bounded Task 8 initial/renewal/recovery command intent with exact source semantics.
- Two-stage Business OS setup remains zero-grant; initial recurring, renewal, and recovery are distinct and interval-monotonic. No provider state is copied into an entitlement grant state machine.

### `@syntholo/integrations`

- Official `stripe` SDK pinned exactly to `22.3.2`; bundled API version is `2026-06-24.dahlia`.
- Production root exposes a narrow hosted Checkout/Portal factory and a separate worker read factory. Injectable clients live only under the test-only subpath and are forbidden from production closures.
- Checkout snapshots cover one-time receipt-only/formal-invoice policy, public/member Business OS setup, Business OS recurring, early Club setup mode, and immediate Club subscription.
- All calls use server-owned canonical app URLs, fixed quantity 1 where line items exist, caller-persisted UUID action keys and integration identifier, exact metadata, dynamic payment methods, and no promotion/adjustable-quantity authority.
- Tax defaults disabled and can be enabled only with exact registration/catalog/Product-tax-code attestation input.
- Canonical retrieval uses pinned Dahlia shapes: Checkout line-item expansion, SetupIntent PaymentMethod expansion/attachment match, Invoice payments expansion plus complete default lines, and bounded non-paginated collections.
- Returned shapes exclude raw provider objects and PII. Provider errors map to safe retryable/terminal adapter codes without retained causes/bodies.
- Webhooks verify exact raw bytes through the official public verifier, tolerate at most 300 seconds, cap raw bodies at 1 MiB, support explicit current/previous key IDs, normalize direct-account omitted account/context to null, and separate signature failure from signed terminal context/event mismatch.

### Configuration and test composition

- API and worker parsers are separate and fail closed if the process contains the other service's raw authorities.
- Restricted keys are mode-bound (`test`/`live`), action/read/API keys are distinct by deployment fingerprint attestation, and the API parser returns one complete immutable endpoint binding.
- Web config and the production dependency gate reject every Stripe server environment variable.
- The reusable deterministic fake is test-only, refuses production construction, returns per-call immutable snapshots, records immutable argument snapshots, and supplies canonical objects/events/signatures without provider I/O.

## Verification

- `npm test`: 1,122/1,122 tests passed across all workspaces.
- `npm run lint`: passed across all workspaces.
- `npm run typecheck`: passed across all workspaces.
- Production build passed for API, web, and worker using an isolated secret-free build environment and the verified baseline release SHA.
- Real production dependency graph: `pass=true`, zero violations.
- Static scans found no production secret-shaped Stripe credentials, no high-entropy provider IDs, and no non-test import of the integration test adapter/fake.
- `git diff --check`: passed.

## Concerns / handoff

- Tasks 2–3 must compose these factories from the new service-specific parsers; they must not import the test-only adapter subpath.
- Provider catalog attestation, persistence, webhook routes/workers, fulfillment orchestration, and provider object configuration remain deliberately outside Task 1.
- No live Stripe calls or provider mutations were made.
