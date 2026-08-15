# ADR: Canonical v1 REST route contract and migration sequence

**Status:** Accepted; root rulings incorporated
**Date:** 2026-08-14
**Deciders:** Production program owner, API/domain owner, security owner
**Scope:** The 15 fixed product paths and 20 path-unspecified product command families in the Commerce, Content, Human Operations, and Business OS focused plans.

## Context

The PRD and production addendum establish separate public, Clerk-member, WorkOS-staff, and signed-provider surfaces. The focused plans fix 15 product paths but otherwise name route modules and commands without fixing their REST shapes. Client work, Zod contracts, authorization tests, and database migrations must not begin against locally invented paths.

This ADR makes one v1 contract while preserving these non-negotiable boundaries:

- the API is the only business-write authority;
- Clerk and WorkOS identities are never interchangeable;
- every member-owned read or write is scoped to the actor's immutable `accountId` and protected by scoped repositories plus RLS;
- no public certificate lookup, certificate identifier, verification endpoint, QR code, or accreditation claim exists;
- Circle owns community posts, comments, reactions, files, and moderation content; Syntholo exposes only access-sync state and a handoff;
- HighLevel remains isolated: no API client, webhook, credential, SSO/session exchange, embedded surface, or customer-data mirror exists;
- Self-Paced and Guided Pilot payment creation remains blocked unless the current production course has exactly 18 ready, published required lessons and a current human approval for the same content hash;
- Business OS commercial and operating state never creates, revokes, pauses, or checks Academy, support, Circle, or Operator Club grants.

## Decision

### 1. HTTP and representation conventions

- All product routes are under `/v1` and are registered only in `apps/api`.
- Request and response schemas live in `packages/contracts`; route adapters do authentication, validation, cache headers, and translation only. Domain transitions live in `packages/domain` or `apps/api/src/modules`; persistence lives in scoped `packages/database` repositories.
- JSON routes accept and return `application/json`. Unknown request fields are rejected. Timestamps are UTC RFC 3339 strings. IDs are opaque strings and have no client-visible embedded meaning.
- A successful single-resource response is the resource document itself, matching the existing API convention. A collection is `{ "items": [...], "nextCursor": string | null }`. A command returning a durable resource returns that resource, not `{ ok: true }`.
- Creation returns `201`; synchronous queries and completed commands return `200`; accepted asynchronous work returns `202`; idempotent deletion/revocation with no representation returns `204`; external-provider and explicitly signed private-file handoffs use `303` with `Location` and no response body. An authenticated API that server-fetches a private object may instead stream a verified `200` response when its route contract says so.
- Every response includes `x-correlation-id`. Errors retain the already-implemented shape:

  ```json
  {
    "error": {
      "code": "STABLE_MACHINE_CODE",
      "message": "Customer-safe message",
      "correlationId": "uuid",
      "details": {}
    }
  }
  ```

  `details` is optional, allowlisted, and must not contain provider payloads, private content, tokens, stack traces, names, emails, file names, transcripts, support bodies, or artifact data.

- Status mapping is stable: malformed input `400 VALIDATION_ERROR`; missing/invalid identity `401 UNAUTHENTICATED`; valid identity lacking permission/capability `403 FORBIDDEN`; recent login required `403 RECENT_AUTH_REQUIRED`; cross-account or non-visible resource `404 NOT_FOUND`; optimistic/idempotency/state conflict `409`; expired bearer token `410`; rate limit `429`; dependency failure `503 DEPENDENCY_UNAVAILABLE`. No route reveals whether a cross-account ID exists.

### 2. Authentication, account scope, CSRF, and recent authentication

- `/v1/public/**` is anonymous unless a route uses an explicit opaque bearer-by-token capability. Public routes never infer member eligibility from an optional or dual-provider token.
- Anonymous write rate limits use a server-issued random 128-bit `anonymous_principal` cookie (Secure, HttpOnly, SameSite=Lax, no user data) as the stable retry/idempotency scope. On the first request the server creates the principal before command execution and binds it to the command receipt. Raw IP address is only a short-lived secondary abuse signal; it is never the sole principal, and the system does not build a browser fingerprint or persist raw IP in command receipts.
- `/v1/member/**` accepts only a Clerk member token with the member issuer/audience. The member actor supplies `accountId`, membership ID, member ID, and role. Member request bodies and query strings never accept `accountId`, member ID, entitlement flags, price IDs, or amounts as authority.
- `/v1/staff/**` accepts only the WorkOS staff session and requires the named permission. Admin MFA is enforced by WorkOS policy. Staff cross-account access is explicit, permission-checked, scoped in the repository call, and audited when it mutates state or exposes sensitive account context. Coaches never receive commerce, refund, card, revenue, entitlement-administration, staff-administration, or unrestricted-export data.
- `/v1/webhooks/**` accepts only a verified provider signature over the route-scoped raw body. It never accepts Clerk or WorkOS as alternate authorization.
- State-changing cookie-authenticated staff requests and pending-token cookie requests require the existing same-origin/CSRF control. Allowed browser origins are explicit by environment.
- Every path-token route, including `:reportToken` and `:authorizationToken`, sets `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Access logging records only the matched route template, never the raw URL/path. Sentry transaction names and breadcrumbs use the route template, and analytics receives neither raw URLs nor tokens. Token values are redacted from structured request fields, errors, traces, metrics labels, audit data, and provider-safe metadata before any sink receives them.
- `R5` below means trusted provider authentication time no more than 300 seconds old. Reauthentication is mandatory for ownership transfer, seat replacement, Pilot decisions, content schedule/publish/archive, content-readiness approval, refund/provider-action approval or legal override, protected session join-metadata changes, certificate redelivery, Business OS activation or destructive state transition, notification replay, and job replay. A client-supplied timestamp never satisfies `R5`.

### 3. Request idempotency

- `I` below means a required `Idempotency-Key` header: 16-128 URL-safe characters generated per user intent. The server scopes it to `(actor or anonymous rate-limit principal, HTTP method, route template, key)` and stores a canonical request hash, status, and safe response.
- A replay with the same canonical request returns the original status and response without a second mutation, audit event, outbox event, notification, provider call, reservation, or capacity change. A key reused with a different request returns `409 IDEMPOTENCY_KEY_REUSED`. An in-flight duplicate returns `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After`.
- Command receipts are retained at least 30 days. Provider-event and financial/provider-action receipts follow the seven-year financial retention requirement. Keys contain no email, token, or other PII.
- `PUT`, `PATCH`, and `DELETE` are replay-safe by resource identity plus `expectedVersion`/current state. They still use `I` where a provider side effect, immutable event, or customer notification could otherwise duplicate.
- Webhooks do not use `Idempotency-Key`; their idempotency key is `(provider, providerEventId)`. Duplicate processed events return `200` with the same minimal acknowledgement.

### 4. Pagination, filtering, caching, and concurrency

- Every unbounded collection uses opaque cursor pagination: `?limit=25&cursor=...`, default 25, maximum 100. The cursor encodes the route's immutable filter set and stable sort tuple, normally `(createdAt DESC, id DESC)`. Invalid or filter-mismatched cursors return `400 INVALID_CURSOR`. Offset pagination is not part of v1.
- Staff queue routes may add allowlisted filters and documented sort keys, but the cursor binds them. Message, version, decision, attempt, delivery, and event histories are also cursor-paginated.
- Public offer display responses use `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=60` and an ETag. Cached availability is advisory only. Every Checkout command re-reads the offer, operational readiness, and current persisted content-readiness approval in the same authorization operation before calling Stripe.
- Token-bearing public reports, all member/staff responses, signed playback, join data, external-login handoffs, signed downloads, checkout responses, and all mutations use `Cache-Control: no-store`. Authenticated responses include `Vary: Authorization, Cookie` as applicable.
- Optimistically edited resources require `expectedVersion`; stale writes return `409 VERSION_CONFLICT` with safe current-version metadata, never another member's private draft/body. `If-Match` may be supported later but is not a v1 substitute for the typed field.

### 5. Raw webhook rules

- Only `POST /v1/webhooks/stripe` and `POST /v1/webhooks/mux` enable the Fastify raw-body option. Ordinary JSON routes retain normal parsing and never retain raw bodies.
- The exact received bytes are verified before JSON parsing or domain dispatch, using the provider's supported signature verifier, configured endpoint secret, timestamp/replay tolerance, and environment. Missing, malformed, stale, or wrong-environment signatures return `400 WEBHOOK_SIGNATURE_INVALID` and cause no receipt or domain mutation.
- After signature verification, the API claims `(provider, eventId)` before mutation. The receipt records safe type/state/attempt metadata, not the provider body. Domain mutation, audit, and outbox occur atomically. Unknown valid event types are acknowledged and recorded without mutation.
- A processed duplicate returns `200 { "received": true }`. A retryable processing failure returns a retryable non-2xx response only after the receipt is marked retryable; terminal schema/environment failures are operations-visible and never partially fulfill.
- Webhook routes are rate/body-size bounded, have request logging/body capture disabled, and never expose signature headers, payloads, customer data, or provider error bodies to logs, Sentry, analytics, or API responses.

## Fixed paths retained verbatim

These paths are pre-existing focused-plan contracts and are not renamed by this ADR.

| Method and path | Authorization | Idempotency / special rule | Owner |
|---|---|---|---|
| `POST /v1/public/scorecards` | Anonymous, rate-limited | `I`; creates lead/report only, never access | `routes/public/scorecards.ts` |
| `POST /v1/public/pilot-applications` | Anonymous, rate-limited | `I` | `routes/public/pilot-applications.ts` |
| `GET /v1/public/scorecards/:reportToken` | Opaque bearer-by-token | Expires exactly 30 days after issuance; token hashed at rest; `no-store`; `Referrer-Policy: no-referrer`; raw path redacted | `routes/public/scorecards.ts` |
| `POST /v1/public/checkouts` | Anonymous, rate-limited | `I`; server price; fresh readiness check | `routes/public/checkouts.ts` |
| `POST /v1/public/pilot-checkouts/:authorizationToken` | Opaque 72-hour, single-use authorization | `I`; Guided Pilot content gate and cohort reservation rechecked | `routes/public/checkouts.ts` |
| `POST /v1/webhooks/stripe` | Stripe raw-body signature | Provider event receipt; exact-once fulfillment | `routes/webhooks/stripe.ts` |
| `POST /v1/public/claims/initiate` | Anonymous, rate-limited | Token only in body; hash then set Secure/HttpOnly/SameSite=Strict cookie | `routes/member/claims.ts` registering its public subroute |
| `GET /v1/member/claims/pending` | Clerk candidate + pending-claim cookie | `no-store`; never accepts path/query token | `routes/member/claims.ts` |
| `POST /v1/member/claims/pending/redeem` | Clerk candidate + pending-claim cookie | `I`; verified-email match; atomic single use | `routes/member/claims.ts` |
| `GET /v1/member/courses/:courseId` | Clerk member + course access/enrollment | Actor-scoped, published enrolled version only | `routes/member/learning.ts` |
| `GET /v1/member/lessons/:lessonId` | Clerk member + course access/enrollment | Actor-scoped, published enrolled version only | `routes/member/learning.ts` |
| `PUT /v1/member/lessons/:lessonId/resume` | Clerk member + course access/enrollment | Replay-safe typed resume update; no account/member ID input | `routes/member/learning.ts` |
| `POST /v1/member/lessons/:lessonId/complete` | Clerk member + course access/enrollment | `I`; immutable completion method `video \| transcript \| mixed` | `routes/member/progress.ts` |
| `GET /v1/member/certificate-recipient-name` | Active actor-bound Clerk membership | Current confirmed canonical name version or null; independent of entitlement/course access | `routes/member/certificates.ts` |
| `PUT /v1/member/certificate-recipient-name` | Active actor-bound Clerk membership | `I`; exact membership-scoped optimistic update; independent of entitlement/course access | `routes/member/certificates.ts` |
| `GET /v1/member/certificates` | Active actor-bound Clerk membership | Only personal certificates for that exact membership; independent of current entitlement/course access; no public equivalent | `routes/member/certificates.ts` |
| `POST /v1/member/support/threads/:id/messages` | Clerk member + support access; thread in actor account | `I`; body never enters audit/analytics | `routes/member/support.ts` |

## Canonical routes for the 20 previously unspecified families

The route list below is exhaustive for the named v1 commands. `I` and `R5` have the meanings above. Permission names are contract names; their WorkOS mapping is deployment configuration.

### 1. Offer catalog and availability

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/public/offers` | Public | Globally displayable offer catalog and safe global `available/reasonCode`; never emits Stripe price IDs | `routes/public/offers.ts` |
| `GET /v1/public/offers/:offerCode` | Public | One public offer; same cache policy | `routes/public/offers.ts` |

Operator Club account eligibility and start time are deliberately returned by its member quote route, not inferred from an optional identity on a public route. Self-Paced and Guided Pilot availability is `CURRICULUM_GATE_BLOCKED` until the exact current 18-lesson hash has both automated pass and human approval. Business OS uses only its separate operational-readiness flag.

### 2. Pilot review, cohort assignment, and private Checkout delivery

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/staff/pilot-applications` | WorkOS `applications:review` | Cursor list; safe applicant/review data | `routes/staff/applications.ts` |
| `GET /v1/staff/pilot-applications/:applicationId` | WorkOS `applications:review` | Application and paginated decision history | `routes/staff/applications.ts` |
| `POST /v1/staff/pilot-applications/:applicationId/decisions` | WorkOS admin, `applications:approve`, `R5` | `I`; body `{ decision, reason, cohortId? }`; approval requires capacity and cohort | `routes/staff/applications.ts` |
| `PUT /v1/staff/pilot-applications/:applicationId/cohort-assignment` | WorkOS admin, `applications:approve`, `R5` | `I`, `expectedVersion`, reason; locks cohort capacity | `routes/staff/applications.ts` |
| `POST /v1/staff/pilot-applications/:applicationId/checkout-authorizations` | WorkOS admin, `applications:approve`, `R5` | `I`; creates/reuses one 72-hour single-use authorization and enqueues delivery; returns `202` without raw token | `routes/staff/applications.ts` |
| `GET /v1/staff/cohorts` | WorkOS `cohorts:read` | Cursor list with capacity, never card data | `routes/staff/cohorts.ts` |
| `POST /v1/staff/cohorts` | WorkOS admin, `cohorts:manage` | `I`; creates cohort | `routes/staff/cohorts.ts` |
| `PATCH /v1/staff/cohorts/:cohortId` | WorkOS admin, `cohorts:manage` | `expectedVersion`; no silent capacity reduction below reservations | `routes/staff/cohorts.ts` |

### 3. Seats, invitations, invitation redemption, replacement, and owner transfer

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/member/seats` | Clerk account owner/member | Account's three safe seat positions; action flags only for owner | `routes/member/seats.ts` |
| `POST /v1/member/seat-invitations` | Clerk owner | `I`, rate-limited; reserves under account lock; invitation email via outbox | `routes/member/seats.ts` |
| `POST /v1/member/seat-invitations/:invitationId/resends` | Clerk owner | `I`, rate-limited; supersedes prior token generation | `routes/member/seats.ts` |
| `DELETE /v1/member/seat-invitations/:invitationId` | Clerk owner | Idempotent revoke and reservation release | `routes/member/seats.ts` |
| `POST /v1/public/seat-invitations/initiate` | Anonymous, rate-limited | `I`; hashes raw token, sets Secure/HttpOnly/SameSite=Strict pending-invitation cookie, removes token from navigation | `routes/public/seat-invitations.ts` |
| `GET /v1/member/seat-invitations/pending` | Clerk invitee candidate + pending cookie | Safe business/role preview; verified email required at redeem | `routes/member/seats.ts` |
| `POST /v1/member/seat-invitations/pending/redeem` | Clerk invitee candidate + pending cookie | `I`; atomic token consumption and seat activation | `routes/member/seats.ts` |
| `POST /v1/member/seats/:membershipId/replacements` | Clerk owner, `R5` | `I`; reason required; creates replacement invitation and revokes/releases old assignment atomically per policy | `routes/member/seats.ts` |
| `POST /v1/member/ownership-transfers` | Clerk owner, `R5` | `I`; body names active target membership and reason; atomic role swap and audit | `routes/member/seats.ts` |

No member endpoint accepts `accountId`; the token/cookie establishes a candidate only and never grants access by itself.

### 4. Operator Club quote and subscription

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `POST /v1/member/operator-club/quotes` | Clerk owner with valid Academy purchase | `I`; body only selects `monthly \| annual`; returns server price display, `schedule \| immediate`, and authoritative `startsAt` | `routes/member/operator-club.ts` |
| `POST /v1/member/operator-club/subscriptions` | Clerk owner with valid Academy purchase | `I`; consumes unexpired quote ID, calls Stripe idempotently, returns schedule/subscription state | `routes/member/operator-club.ts` |

The server computes `startsAt = max(exact included-support end, trusted fulfillment now)`. Operator Club changes only Club-derived support, Circle-write, and Club grants; it never changes lifetime Academy access.

### 5. Commerce cases and verified provider results

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `POST /v1/member/commerce-cases` | Clerk owner | `I`, rate-limited; opens `refund \| cancellation` request against an account-visible purchase/subscription | `routes/member/commerce-cases.ts` |
| `GET /v1/member/commerce-cases` | Clerk owner | Cursor list for actor account | `routes/member/commerce-cases.ts` |
| `GET /v1/staff/commerce-cases` | WorkOS admin, `commerce:cases:read` | Cursor list/filter; never available to coach | `routes/staff/commerce-cases.ts` |
| `GET /v1/staff/commerce-cases/:caseId` | WorkOS admin, `commerce:cases:read` | Case, policy, immutable decision/provider-action history | `routes/staff/commerce-cases.ts` |
| `POST /v1/staff/commerce-cases/:caseId/decisions` | WorkOS admin, `commerce:cases:decide`, `R5` | `I`; approve/deny/legal override, reason and policy version required | `routes/staff/commerce-cases.ts` |
| `POST /v1/staff/commerce-cases/:caseId/provider-actions` | WorkOS admin, `commerce:provider:act`, `R5` | `I`; persists intent, calls provider outside DB transaction, returns `202` when awaiting provider event | `routes/staff/commerce-cases.ts` |

There is no staff endpoint for asserting a provider result. Signed Stripe events at the fixed webhook route are the authoritative application path for asynchronous results; a synchronous provider response may be applied only by the module that made the idempotent call and must later reconcile to a signed event. Progress, earned certificates, account, financial, and audit history are never deleted.

### 6. Content drafts, previews, schedules, publications, archives, and history

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `POST /v1/staff/content/courses` | WorkOS admin, `content:write` | `I`; creates draft course | `routes/staff/content.ts` |
| `PATCH /v1/staff/content/courses/:courseId` | WorkOS admin, `content:write` | `expectedVersion`; draft metadata/order only | `routes/staff/content.ts` |
| `POST /v1/staff/content/courses/:courseId/stages` | WorkOS admin, `content:write` | `I`; creates/reorders within draft | `routes/staff/content.ts` |
| `PATCH /v1/staff/content/stages/:stageId` | WorkOS admin, `content:write` | `expectedVersion`; draft only | `routes/staff/content.ts` |
| `POST /v1/staff/content/stages/:stageId/lessons` | WorkOS admin, `content:write` | `I`; creates lesson draft | `routes/staff/content.ts` |
| `PATCH /v1/staff/content/lessons/:lessonId` | WorkOS admin, `content:write` | `expectedVersion`; draft only; published versions immutable | `routes/staff/content.ts` |
| `GET /v1/staff/content/courses/:courseId/preview` | WorkOS `content:read` | Immutable preview projection | `routes/staff/content.ts` |
| `GET /v1/staff/content/lessons/:lessonId/preview` | WorkOS `content:read` | Immutable preview projection and all blockers | `routes/staff/content.ts` |
| `POST /v1/staff/content/courses/:courseId/schedules` | WorkOS admin, `content:publish`, `R5` | `I`; `expectedVersion`, future time, reason; durable authorizing decision | `routes/staff/content.ts` |
| `POST /v1/staff/content/lessons/:lessonId/schedules` | WorkOS admin, `content:publish`, `R5` | Same controls | `routes/staff/content.ts` |
| `POST /v1/staff/content/courses/:courseId/publications` | WorkOS admin, `content:publish`, `R5` | `I`; validates and creates immutable version; reason | `routes/staff/content.ts` |
| `POST /v1/staff/content/lessons/:lessonId/publications` | WorkOS admin, `content:publish`, `R5` | Same controls; all publication blockers returned together | `routes/staff/content.ts` |
| `POST /v1/staff/content/courses/:courseId/archives` | WorkOS admin, `content:publish`, `R5` | `I`; reason; never edits/deletes history | `routes/staff/content.ts` |
| `POST /v1/staff/content/lessons/:lessonId/archives` | WorkOS admin, `content:publish`, `R5` | Same controls | `routes/staff/content.ts` |
| `GET /v1/staff/content/courses/:courseId/versions` | WorkOS `content:read` | Cursor history | `routes/staff/content.ts` |
| `GET /v1/staff/content/lessons/:lessonId/versions` | WorkOS `content:read` | Cursor history | `routes/staff/content.ts` |

These suffixes are the canonical expansion of the focused plan's `POST/PATCH /v1/staff/content/...` family. Scheduled publication runs only from its stored admin authorization; the worker has no public HTTP command.

### 7. Mux event processing and lesson playback

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `POST /v1/webhooks/mux` | Mux raw-body signature | Provider receipt; exact-once internal asset/track readiness update | `routes/webhooks/mux.ts` |
| `GET /v1/member/lessons/:lessonId/playback` | Clerk member with active membership, course access, enrollment | `no-store`; five-minute signed playback data; degraded response includes authorized transcript/summary/action/resources | `routes/member/lesson-playback.ts` |

Mux asset IDs and safe readiness state may be stored; transcript content never enters logs, analytics, Sentry, or webhook receipts.

### 8. Account-shared artifacts and immutable versions

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/member/artifacts` | Clerk member with Academy access | Actor-account collection; cursor if history/filters expand | `routes/member/artifacts.ts` |
| `GET /v1/member/artifacts/:artifactId` | Clerk member with Academy access | Current account-shared representation and version metadata | `routes/member/artifacts.ts` |
| `GET /v1/member/artifacts/:artifactId/versions` | Clerk member with Academy access | Cursor immutable history | `routes/member/artifacts.ts` |
| `POST /v1/member/artifacts/:artifactId/versions` | Clerk member with Academy access | `I`; `expectedVersion`; `409 VERSION_CONFLICT` on stale write | `routes/member/artifacts.ts` |

Artifact content is never copied into audit, analytics, error details, or Sentry. Review state is owned by the review routes, not mutated here.

### 9. Private certificate download and staff-assisted delivery

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/member/certificates/:certificateId/download` | Active Clerk membership that personally earned that certificate | Authenticated server fetch of the exact private object; streamed `200 application/pdf`; `private, no-store`; no provider URL/token | `routes/member/certificates.ts` |
| `POST /v1/staff/certificates/:certificateId/deliveries` | WorkOS admin, `certificates:deliver`, `R5` | `I`; reason; creates an immutable audited `delivery_pending` request and performs no send; returns `202` | `routes/staff/certificates.ts` |

There is intentionally no `/v1/public/certificates`, lookup, verify, certificate-ID, or public download route. Account teammates cannot fetch one another's certificate.

### 10. Curriculum launch readiness

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `POST /v1/staff/content-readiness/evaluations` | WorkOS admin, `content:readiness:evaluate` | `I`; computes and persists canonical hash/report; cannot force pass | `routes/staff/content-readiness.ts` |
| `GET /v1/staff/content-readiness` | WorkOS `content:readiness:read` | Cursor evaluation history/current summary | `routes/staff/content-readiness.ts` |
| `GET /v1/staff/content-readiness/:evaluationId` | WorkOS `content:readiness:read` | Exact per-lesson issues and hash | `routes/staff/content-readiness.ts` |
| `POST /v1/staff/content-readiness/:evaluationId/approvals` | WorkOS admin, `content:readiness:approve`, `R5` | `I`; reason; approves only an automated-pass current hash | `routes/staff/content-readiness.ts` |

Any content change invalidates the approval by hash. The public offer cache cannot enable payment. Both public Self-Paced Checkout and private Guided Pilot Checkout synchronously re-evaluate the persisted current hash and approval before Stripe session creation. Business OS Checkout uses its separate readiness dependency and does not imply Academy readiness or access.

### 11. Account-shared support and coach operations

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/member/support/threads` | Clerk member with support access | Cursor list for actor account | `routes/member/support.ts` |
| `POST /v1/member/support/threads` | Clerk member with support access | `I`, rate-limited; opens thread and first message atomically | `routes/member/support.ts` |
| `GET /v1/member/support/threads/:threadId` | Clerk member with support access; actor account | Thread plus cursor messages | `routes/member/support.ts` |
| `GET /v1/staff/support/threads` | WorkOS coach/admin, `support:read` | Cursor queue with assigned/unassigned filter and SLA projection; no commerce fields | `routes/staff/support.ts` |
| `GET /v1/staff/support/threads/:threadId` | Assigned/eligible WorkOS coach or admin, `support:read` | Account context limited to support need | `routes/staff/support.ts` |
| `POST /v1/staff/support/threads/:threadId/messages` | Assigned WorkOS coach/admin, `support:reply` | `I`; `responseKind`; customer-visible substantive replies may satisfy SLA | `routes/staff/support.ts` |
| `PUT /v1/staff/support/threads/:threadId/assignment` | WorkOS `support:assign` | `I`, `expectedVersion`; manual reassign requires reason; auto-assignment remains internal | `routes/staff/support.ts` |
| `POST /v1/staff/support/threads/:threadId/transitions` | Assigned WorkOS coach/admin, `support:transition` | `I`; action/reason; audited state transition | `routes/staff/support.ts` |
| `POST /v1/staff/support/threads/:threadId/effort-entries` | WorkOS coach/admin, `support:effort` | `I`; `1..480` minutes and allowlisted category; no body content | `routes/staff/support.ts` |

The external support-state union is exactly `new | assigned | waiting_on_coach | waiting_on_customer | resolved | closed` on every member/staff response, filter, event contract, and error detail. Storage may normalize an active thread to an internal `open` lifecycle plus assignment/SLA projections, but `open` is never serialized by the API. The projection is deterministic: unassigned active work is `new`; assigned administrative work not yet waiting on a party is `assigned`; an active customer message awaiting a substantive coach response is `waiting_on_coach`; the other three values map directly. Contract tests reject `open` at the response boundary.

### 12. Artifact reviews

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/member/artifact-reviews` | Clerk member with support access | Actor-account history/current state, cursor-paginated | `routes/member/reviews.ts` |
| `POST /v1/member/artifact-reviews` | Clerk member with support access | `I`; exact immutable `artifactVersionId`; DB enforces one active review/account | `routes/member/reviews.ts` |
| `GET /v1/staff/artifact-reviews` | WorkOS coach/admin, `reviews:read` | Cursor assigned/unassigned queue | `routes/staff/reviews.ts` |
| `GET /v1/staff/artifact-reviews/:reviewId` | Assigned/eligible WorkOS coach/admin | Exact version reference and safe context | `routes/staff/reviews.ts` |
| `POST /v1/staff/artifact-reviews/:reviewId/starts` | Assigned WorkOS coach/admin, `reviews:work` | `I`; submitted to in-review | `routes/staff/reviews.ts` |
| `POST /v1/staff/artifact-reviews/:reviewId/returns` | Assigned WorkOS coach/admin, `reviews:work` | `I`; feedback, exact version, releases account lock | `routes/staff/reviews.ts` |

Audit stores IDs and state only, never artifact or feedback content.

### 13. Quarantined file upload and clean-file download

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `POST /v1/member/files/uploads` | Clerk member with support access | `I`, rate-limited; validates allowlisted extension/MIME declaration and <=25 MiB; returns private quarantine upload target | `routes/member/files.ts` |
| `GET /v1/member/files/:attachmentId` | Clerk member with support access; actor account | Safe scan/status projection | `routes/member/files.ts` |
| `GET /v1/member/files/:attachmentId/download` | Clerk member with support access; actor account | Clean only; `303` to five-minute private signed URL; `no-store` | `routes/member/files.ts` |
| `GET /v1/staff/files/:attachmentId/download` | Assigned support coach/admin, `support:files:read` | Clean only; scoped to authorized support context; `303`, `no-store` | `routes/staff/files.ts` |

The client can upload only to a server-generated quarantine key. The scan worker verifies actual MIME and moves/copies only clean bytes to the private clean prefix. Quarantined, scanning, rejected, or failed files never receive a download URL.

### 14. Sessions, RSVP, attendance, join metadata, and incidents

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/member/sessions` | Clerk member with applicable cohort/office-hours access | Cursor list; local-time fields; never join metadata | `routes/member/sessions.ts` |
| `POST /v1/member/sessions/:sessionId/rsvps` | Clerk member with applicable access | `I`; capacity/waitlist transaction; returns confirmed/waitlisted | `routes/member/sessions.ts` |
| `DELETE /v1/member/sessions/:sessionId/rsvp` | Clerk member who owns RSVP | Idempotent cancel; atomically promotes oldest waitlisted RSVP | `routes/member/sessions.ts` |
| `GET /v1/member/sessions/:sessionId/join` | Clerk confirmed attendee | `no-store`; available from 15 minutes before start through end; otherwise safe unavailable status | `routes/member/sessions.ts` |
| `GET /v1/staff/sessions` | WorkOS `sessions:read` | Cursor list | `routes/staff/sessions.ts` |
| `POST /v1/staff/session-generations` | WorkOS admin, `sessions:manage` | `I`; Pilot/office-hours generation; recurrence key makes duplicates safe | `routes/staff/sessions.ts` |
| `PUT /v1/staff/sessions/:sessionId/attendance/:membershipId` | WorkOS coach/admin, `sessions:attendance` | `I`; attended/absent with expected RSVP version | `routes/staff/sessions.ts` |
| `GET /v1/staff/sessions/:sessionId/join-metadata` | WorkOS admin, `sessions:manage`, `R5` | `no-store`; protected operations-only value | `routes/staff/sessions.ts` |
| `PUT /v1/staff/sessions/:sessionId/join-metadata` | WorkOS admin, `sessions:manage`, `R5` | `I`; encrypted/protected storage; secret absent from audit | `routes/staff/sessions.ts` |
| `POST /v1/staff/sessions/:sessionId/incidents` | WorkOS coach/admin, `sessions:incident` | `I`; `missing_link \| wrong_link \| timezone_error`, safe reason | `routes/staff/sessions.ts` |
| `GET /v1/staff/sessions/automation-trigger-report` | WorkOS admin, `sessions:manage` | Concurrent cohorts, incidents/90d, scheduling minutes/month | `routes/staff/sessions.ts` |

Zoom creation remains manual. There is no Zoom API route or webhook in v1.

### 15. Circle access handoff/status

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/member/community/handoff` | Clerk active member with computed `write | read_only` community access | `no-store`; returns validated Circle handoff URL and `ready | pending | failed` sync state | `routes/member/community.ts` |

This is the entire Syntholo community HTTP surface. There are no routes for posts, comments, reactions, moderation content, direct messages, or community-file uploads. A Circle failure produces pending/failed sync state and retries/dead-letter work without blocking Academy or support.

### 16. Business OS onboarding and independent state

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/member/business-os` | Clerk member with effective Business OS capability | Actor-account onboarding/provisioning/status, customer-safe incidents, validated external-login hyperlink only | `routes/member/business-os.ts` |
| `PATCH /v1/member/business-os/onboarding` | Clerk owner with effective Business OS capability | `expectedVersion`; approved operational questionnaire fields only | `routes/member/business-os.ts` |
| `GET /v1/staff/business-os/accounts` | WorkOS `business_os:read` | Cursor provisioning queue | `routes/staff/business-os.ts` |
| `GET /v1/staff/business-os/accounts/:accountId` | WorkOS `business_os:read` | Explicit audited account scope; no Academy mutation interface and no HighLevel data | `routes/staff/business-os.ts` |
| `PATCH /v1/staff/business-os/accounts/:accountId` | WorkOS admin, `business_os:manage` | `expectedVersion`, reason; `R5` for suspend/cancel or other access-affecting transition | `routes/staff/business-os.ts` |

The external URL is built from an environment-approved HTTPS origin plus opaque path, contains no Syntholo token or customer query data, opens separately, and is never embedded. There is no HighLevel webhook, API route, OAuth callback, credential, or SSO route.

### 17. Business OS seven-check activation

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/staff/business-os/accounts/:accountId/checks` | WorkOS `business_os:read` | Latest current check set and cursor history; opaque evidence refs only | `routes/staff/business-os-checks.ts` |
| `PUT /v1/staff/business-os/accounts/:accountId/checks/:checkCode` | WorkOS admin, `business_os:verify` | `I`, `expectedVersion`; pending/passed/failed, opaque evidence ref, checked time | `routes/staff/business-os-checks.ts` |
| `POST /v1/staff/business-os/accounts/:accountId/activations` | WorkOS admin, `business_os:activate`, `R5` | `I`; reason; atomically re-reads seven current passed checks and ready state | `routes/staff/business-os-checks.ts` |

`checkCode` is exactly one of `lead_capture`, `lead_routing`, `calendar_booking`, `two_way_messaging`, `client_onboarding`, `ai_human_escalation`, or `dashboard_reporting`. Activation never loads or changes Academy entitlements.

### 18. Business OS verification, incidents, and monitoring trigger report

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/staff/business-os/verifications` | WorkOS `business_os:read` | Cursor due/run list | `routes/staff/business-os-verification.ts` |
| `GET /v1/staff/business-os/verifications/:runId` | WorkOS `business_os:read` | Seven results, cadence reason, safe linked incident | `routes/staff/business-os-verification.ts` |
| `POST /v1/staff/business-os/accounts/:accountId/verifications` | WorkOS admin, `business_os:verify` | `I`; starts `monthly \| material_change \| customer_report`; unique period/reason | `routes/staff/business-os-verification.ts` |
| `POST /v1/staff/business-os/verifications/:runId/completions` | WorkOS admin, `business_os:verify`, `R5` | `I`; exactly seven results; atomically degrade/open incident or restore/resolve | `routes/staff/business-os-verification.ts` |
| `POST /v1/staff/business-os/accounts/:accountId/incidents` | WorkOS admin, `business_os:incident` | `I`; customer-report/material-change incident; no customer data body | `routes/staff/business-os-verification.ts` |
| `POST /v1/staff/business-os/incidents/:incidentId/resolutions` | WorkOS admin, `business_os:incident`, `R5` | `I`; reason and passed current verification required for recovery | `routes/staff/business-os-verification.ts` |
| `GET /v1/staff/business-os/monitoring-trigger-report` | WorkOS admin, `business_os:read` | Active accounts, early degradations/90d, operator minutes/month | `routes/staff/business-os-verification.ts` |

Cron only enqueues due-run jobs with unique `(accountId, periodStart, reason)`; it has no externally callable route. Business OS degradation or recovery never touches Academy, support, Circle, or Operator Club state.

### 19. Notification delivery and replay

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/staff/notifications` | WorkOS admin, `notifications:read` | Cursor delivery list with safe status/attempt metadata | `routes/staff/notifications.ts` |
| `GET /v1/staff/notifications/:deliveryId` | WorkOS admin, `notifications:read` | One logical delivery and cursor attempts; no rendered private body | `routes/staff/notifications.ts` |
| `POST /v1/staff/notifications/:deliveryId/replays` | WorkOS admin, `notifications:replay`, `R5` | `I`; reason; new audited attempt on same logical delivery, returns `202` | `routes/staff/notifications.ts` |

The logical key remains `(eventId, recipientId, templateVersion, channel)`; replay never creates a duplicate logical notification record.

### 20. Operations health, jobs, dead letters, incidents, and replay

| Method and path | Authorization | Controls and response | Owner |
|---|---|---|---|
| `GET /v1/staff/operations/health` | WorkOS admin, `operations:read` | Safe API/worker/cron/dependency metric projection; no URLs, keys, or account IDs | `routes/staff/operations.ts` |
| `GET /v1/staff/operations/jobs` | WorkOS admin, `operations:read` | Cursor jobs/attempts summary | `routes/staff/operations.ts` |
| `GET /v1/staff/operations/jobs/:jobId` | WorkOS admin, `operations:read` | Safe payload type, attempts, impact, next action; no private payload | `routes/staff/operations.ts` |
| `GET /v1/staff/operations/dead-letters` | WorkOS admin, `operations:read` | Cursor dead-letter queue | `routes/staff/operations.ts` |
| `GET /v1/staff/operations/incidents` | WorkOS admin, `operations:read` | Cursor cross-domain safe incident list | `routes/staff/operations.ts` |
| `POST /v1/staff/operations/jobs/:jobId/replays` | WorkOS admin, `operations:replay`, `R5` | `I`; reason and dry-run impact acknowledgement; audited enqueue, returns `202` | `routes/staff/operations.ts` |

The existing public `GET /v1/health/live` and `GET /v1/health/ready` remain infrastructure probes and are not replacements for this protected operations surface.

## Route-module ownership and composition

- Each file named above owns only its route adapter. It imports a typed module interface and contract schemas; it does not contain Stripe/Mux/Circle/Blob/Resend logic or direct SQL.
- `routes/public/**`, `routes/member/**`, `routes/staff/**`, and `routes/webhooks/**` are registered under distinct auth hooks. No plugin is mounted under two identity verifiers.
- Member repositories require `accountId` and, where personal, member/enrollment ID. Staff repositories require an explicit staff scope and permission; worker repositories use a separate capability role. Cross-account denial tests run under the actual member RLS role.
- Provider adapters remain in `packages/integrations`. Community has only a Circle access adapter. Business OS deliberately has no HighLevel adapter.
- Worker and cron handlers are not exposed as HTTP routes. Only audited staff replay commands enqueue work through the durable jobs system.

## Migration numbering decision

The repository has immutable applied/planned foundation migrations through
`0007_runtime_contract.sql`. The approved dashboard vertical slice requires the
first additive hardening migration, so `0008` belongs to account-name storage.
All downstream product migrations then follow the actual approved implementation
waves. No existing `0001`-`0007` file is renamed or rebased, and no lower-numbered
migration may be inserted after a higher number has reached a shared environment.

| New file | Replaces focused-plan name | Domain |
|---|---|---|
| `0008_account_name.sql` | dashboard prerequisite | Canonical account-name storage hardening |
| `0009_content.sql` | `0008_content.sql` | Course/stage/lesson/block/version lifecycle |
| `0010_content_assets.sql` | `0009_content_assets.sql` | Mux assets, tracks, readiness |
| `0011_learning.sql` | `0010_learning.sql` | Enrollment, progress, resume, completion facts |
| `0012_implementation.sql` | `0011_implementation.sql` | Account artifacts and immutable versions |
| `0013_certificates.sql` | `0012_certificates.sql` | Private certificate records/files |
| `0014_commerce_catalog.sql` | `0005_commerce_catalog.sql` | Offers, prices, Checkout authorization/purchases/Stripe state |
| `0015_applications.sql` | `0006_applications.sql` | Scorecards, consent/attribution, Pilot applications/cohorts |
| `0016_commerce_cases.sql` | `0007_commerce_cases.sql` | Cases, decisions, provider actions |
| `0017_support.sql` | `0013_support.sql` | Account-shared threads/messages |
| `0018_coach_operations.sql` | `0014_coach_operations.sql` | Assignment, SLA, effort |
| `0019_review_lock.sql` | `0015_review_lock.sql` | Artifact reviews and active-account lock |
| `0020_attachments.sql` | `0016_attachments.sql` | Quarantine/scan/download state |
| `0021_sessions.sql` | `0017_sessions.sql` | Sessions, RSVP, waitlist, attendance |
| `0022_session_delivery.sql` | `0018_session_delivery.sql` | Protected join metadata and delivery |
| `0023_community.sql` | `0019_community.sql` | Circle desired/current access sync only |
| `0024_business_os.sql` | `0020_business_os.sql` | Isolated onboarding/provisioning state |
| `0025_business_os_checks.sql` | `0021_business_os_checks.sql` | Seven activation checks |
| `0026_business_os_verification.sql` | `0022_business_os_verification.sql` | Verification runs/results/incidents |
| `0027_notifications.sql` | `0023_notifications.sql` | Template/delivery receipts |
| `0028_analytics.sql` | `0024_analytics.sql` | Allowlisted analytics queue/delivery |
| `0029_privacy.sql` | `0025_privacy.sql` in launch/acquisition hardening | Privacy/export/deletion additions |

Before implementation, update every focused-plan file reference, migration test expectation, and Drizzle journal tag as one documentation/configuration change. Never create compatibility placeholders under the collided old numbers. Migration deployment order remains migration, API, worker, then web; each migration must be backward compatible with the prior application release.

## Options considered

### One command endpoint per use case

Rejected as the default. Paths such as `/approvePilot` or `/activateBusinessOs` expose implementation verbs, fragment list/history ownership, and make authorization/pagination inconsistent. Explicit subresources such as decisions, publications, activations, completions, and replays preserve command intent while keeping durable records addressable.

### Generic `/commands` endpoint

Rejected. It would weaken route-level WorkOS permissions, raw-webhook isolation, rate limits, OpenAPI/Zod contracts, cache rules, and audit ownership.

### Optional member identity on public offers

Rejected. A route accepting both anonymous and Clerk contexts risks issuer confusion and cache leakage. Public offers expose global availability; the protected Operator Club quote computes account eligibility.

### Public certificate verification

Rejected as an explicit v1 non-goal. Private member download plus audited staff-assisted redelivery satisfies delivery without creating certificate identifiers or a lookup surface.

## Consequences

- Web clients and contract tests can target one stable route set before repository implementation.
- Identity, account scope, recent-auth, idempotency, cache, and webhook controls are reviewable at route granularity.
- Some command-like operations use plural subresources (`decisions`, `publications`, `replays`) because they create immutable facts rather than mutate invisible state.
- The API surface is larger than a generic RPC endpoint, but ownership and least-privilege boundaries remain explicit.
- All downstream focused plans and the planned privacy migration must adopt the renumbered filenames before schema work.

## Root rulings incorporated

1. **Scorecard report-token lifetime is exactly 30 days.** This is now the binding request/contract/database rule. The Commerce focused plan and endpoint audit text that says seven days is superseded by this root ruling and must be corrected before implementation.
2. **The external support-state union is exactly `new | assigned | waiting_on_coach | waiting_on_customer | resolved | closed`.** Internal storage may normalize active state, but `open` is an implementation detail and must never appear in API schemas, responses, filters, events, analytics, or customer-visible errors. The Human Operations focused-plan text that defines the persisted/API state family as `open | waiting_on_customer | resolved | closed` is superseded at the external contract boundary.

No unresolved source conflict blocks route adoption. Invitation redemption cookie flow, REST subresource naming, permission names, pagination, and response conventions are decisions made by this ADR and do not require separate product expansion.

## Acceptance actions

1. Mark this ADR Accepted after final API/security owner review.
2. Add strict Zod request/response/error schemas and contract tests for every route before web client integration, including rejection of external support state `open`.
3. Update focused-plan route references, the scorecard 30-day lifetime, support response enum, and migration filenames/journal expectations to this ADR.
4. Add authorization matrix tests covering issuer separation, permission denial, recent-auth expiry, cross-account `404`, CSRF, and RLS denial.
5. Add idempotency, anonymous-principal, path-token redaction/referrer, raw-signature/replay, caching, cursor, content-gate, Circle-isolation, certificate-exclusion, and HighLevel-isolation contract tests.
