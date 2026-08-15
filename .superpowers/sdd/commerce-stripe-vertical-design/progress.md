# SDD ledger — plan: .superpowers/sdd/2026-08-13-production-program/commerce-stripe-vertical-design.md

Baseline: `a66ba1017323b9d960403a8f809c66a381dcb204` on `codex/production-platform`.

The original Commerce foundation remains commit `4652def1afa5afc3702ce8e2ee876c443f9429b3`.
The reserved upstream authorities are now published and frozen:

- Task 2 / `0012_implementation.sql`: commit
  `6e4ff831bb0f76622d00953a8b01664b545ec4af`, migration SHA-256
  `dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9`.
- Task 3 / `0013_certificates.sql`: commit
  `af6a7db7272fde9f608c5b3568475b358d698629`, migration SHA-256
  `878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9`.
- Task 4 is complete from that clean Task 8 commit. Its binding brief and
  report are `.superpowers/sdd/commerce-stripe-vertical-design/task-4-brief.md`
  and `.superpowers/sdd/commerce-stripe-vertical-design/task-4-report.md`.
  The frozen `0014_commerce_catalog.sql` SHA-256 is
  `4bc124a641e6912d84fc6675133476f92e52e8fa89151079d05433d31deba8d4`.

## Preflight interface scan

| Producer task | Consumer task | Shared interface | Finding / ruling |
| --- | --- | --- | --- |
| Task 1 contracts/domain/Stripe adapter | Task 2 `0014` persistence | offer codes, Stripe normalized objects, safe errors, idempotency/action identities | Clean if Task 1 contains no persistence authority and Task 2 imports the exact strict contracts. |
| Task 1 Stripe adapter | Task 3 API/webhook composition | Checkout/Portal/event verification ports and typed provider errors | Ruling: pin Stripe API `2026-06-24.dahlia`, omit `payment_method_types`, persist `integration_identifier` before provider calls. Cost if wrong: fixture and provider-attestation rework. |
| Task 2 `0014` | Task 4 `0015` applications/Pilot | offer/catalog/authorization ownership | Clean; Task 4 may reference only published composite keys, never duplicate catalog authority. |
| Task 2 `0014` | Task 5 `0016` cases/refunds/disputes | money/provider objects, receipts, account/source ownership | Clean if Task 5 adds orchestration and never changes Task 8 transitions. |
| Task 2 `0014` | Task 6 paid fulfillment/claim/enrollment | system UoW, Task 8 commands, `0011` pinned learning seed | Ruling: signed paid event is sole money authority; redirect/session response never grants. Cost if wrong: unpaid access or duplicate grants. |
| Task 3 API/webhook | Task 6 fulfillment | immutable receipt + processing fence | Clean; receipt completion and domain mutation must share the account-scoped transaction. |
| Task 6 claim/onboarding | Task 7 production UI/browser | fragment-cleared token, Strict cookie, Clerk candidate | Ruling: raw tokens are cleared before Clerk/telemetry and never enter paths/query/logs. Cost if wrong: credential leakage. |
| Task 7 Self-Paced UI | Task 8 recurring/BOS/Club | common hosted Checkout and pending-state UI | Clean if each offer keeps separate eligibility/source topology. |
| Task 8 recurring/BOS/Club | Task 9 cases/refunds/Portal/reconciliation | provider object mapping and Task 8 source authority | Clean; separate BOS setup and recurring Charges remain binding. |
| Task 9 operations | Task 10 final staging/deploy | evidence/gates/provider configuration | Ruling: code cannot claim tax/legal/provider approval; live offers remain disabled until owner evidence exists. Cost if wrong: financial/legal launch risk. |

Task 1 self-consistency: contracts, pure rules, adapter/config and deterministic fakes can be implemented/tested without database migrations, provider writes, browser UI, or production secrets. This agrees with implementation sequence step 2 and the adapter-test matrix.

Task 1 preflight rulings:

- Ruling: pin `stripe` 22.3.2 because its bundled API version is the binding `2026-06-24.dahlia`; do not silently move to 22.5.0/`2026-07-29.dahlia`. Cost if wrong: provider fixtures, endpoint binding, and canonical retrieval must be re-attested.
- Ruling: raw-signature verification is separate from signed context evaluation. Only missing/malformed/stale/wrong-secret/unparsable input is signature-invalid; a correctly signed wrong mode/version/account/context is a safe terminal normalized event for the future receipt path. Cost if wrong: security events either redeliver forever or bypass durable evidence.
- Ruling: configuration models dual webhook secret/key-ID rotation and separate least-privilege API/worker keys. Cost if wrong: rotation requires downtime or broadens credential blast radius.
- Ruling: `quantity=1` applies to payment/subscription Checkout line items; early-Club `setup` mode has no line items. Add SetupIntent canonical retrieval despite its accidental omission from design §8.3 because §6.5 makes it authoritative. Cost if wrong: early Club cannot prove a reusable payment method or schedule safely.
- Ruling: Commerce `0014` follows the now-published, immutable `0012_implementation.sql` and `0013_certificates.sql` tuples. Re-read the 13-entry journal and both signed handshakes before every candidate freeze. Cost if wrong: later insertion is non-monotonic and can split shared environments permanently.
- Ruling: signed Academy payment creates only the immutable pinned `account_course_access` seed from published `0011`; claim/seat redemption creates the membership-bound enrollment. Never fabricate a membership and never weaken `enrollments.membership_id`. Cost if wrong: enrollment loses person-level ownership or paid fulfillment becomes unimplementable.
- Ruling: `0014` may install only a fail-closed, ungranted placeholder for `syntholo_cleanup_public_bos_intents_v1`; `0016` forward-replaces it with the complete refund/dispute/pending-effect predicates, grants exact worker EXECUTE, and flips cleanup readiness/handler registration. Cost if wrong: enabling cleanup early can delete identity residue while a later payment/dispute/refund effect exists; keeping it disabled costs only delayed abandoned-intent cleanup before 0016.

Task 2 preflight: complete. The signed handoff requires `0012`/`0013` first; exact catalog/Checkout/BOS/financial/claim/receipt/Task8/learning/cleanup/ACL/readiness topology and hostile real-PG matrix are recorded in the controller handoff. Key additive learning change: one active pinned access per `(account_id, entitlement_source_id, course_id)`, while enrollments remain membership-bound.

## Tasks

- Task 1: complete (commits `6ea1529..4652def`, formal spec + quality review clean)
- Task 2: complete — `0012_implementation.sql` shared artifacts/workflows authority (`6e4ff831`, Neon/full gates green)
- Task 3: complete — `0013_certificates.sql` certificate authority (`af6a7db`, Neon/full gates green; live Blob provider exercise remains a later provider gate)
- Task 4: complete — `0014_commerce_catalog.sql`, ACL/RLS/readiness/repositories and real-PG races
- Task 5: complete — signed raw Stripe webhook receipt/API composition, disabled-by-default provider action boundary, real system-login and production-build gates green
- Task 6: `0015_applications.sql` and Pilot/scorecard authority
- Task 7: `0016_commerce_cases.sql` and refund/dispute/reconciliation authority
- Task 8: Self-Paced paid fulfillment, claim, onboarding, seats, pinned access/enrollment
- Task 9: production Checkout/claim/onboarding browser flow
- Task 10: Operator Club and Business OS setup/recurring lifecycle
- Task 11: Portal, cases, refund/dispute/provider-action operations
- Task 12: full commerce review, Stripe test-mode evidence, deployment gates
