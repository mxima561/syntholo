# Account-scoped member dashboard vertical slice

**Status:** Accepted
**Date:** 2026-08-14
**Scope:** the first production member home after Wave 0 containment
**Decision owner:** production-program controller

## 1. Decision summary

Add `GET /v1/member/dashboard` as a read-only API composition over the existing
Clerk member actor, `AccountRepository`, and the same effective-access port used
by `GET /v1/member/access`. The first response contains only real foundation
facts: account identity and effective entitlements/holds/seats,
and explicitly typed unavailable or empty downstream projections. It contains
no demo lesson, progress, artifact, support, session, coach, community, or
Business OS record.

The production web page remains a Next.js Server Component that renders one
small Client Component. Only that Client Component calls `useAuth().getToken()`
and sends the Clerk bearer to the same-origin `/v1` facade. The token is never a
Server Component prop, React state value, URL value, cookie created by Syntholo,
or server log field.

No new product table, durable dashboard write, audit event, outbox event, or
Unit of Work repository is required. One account-name storage hardening
migration and bounded-read/error-translation repository work are prerequisites;
section 7 defines them exactly. Enrollment and onboarding are not backfilled
here. A member with Academy access but no enrollment is an explicit recovery
state whose durable fix belongs to commerce fulfillment/claim and the learning
module.

The dashboard's next-best-step composer is fail-closed by precedence. An
unavailable higher-priority projection blocks recommendations from every lower
priority. For example, unavailable support cannot be skipped in order to show a
lesson or community recommendation.

## 2. Sources and current constraints

This design follows, in order:

1. `docs/architecture/http-route-contract.md`,
   including the incorporated root rulings for `/v1/member/**` auth, scope,
   caching, error, and representation conventions
2. `docs/superpowers/specs/2026-08-12-production-launch-design.md`
3. `docs/product/prd.md`
4. `docs/superpowers/plans/2026-08-13-production-program.md`
5. `docs/superpowers/plans/2026-08-13-launch-acquisition-hardening.md`, which
   fixes the dashboard path
6. the focused commerce, content/learning, human-operations, and Business OS
   plans
7. the implemented foundation code and database boundary

Relevant current facts:

- `authenticateMember` accepts exactly one Clerk session bearer, rejects staff
  cookies/mixed credentials, verifies audience and authorized party, then maps
  the Clerk user to one active PostgreSQL account and membership.
- `GET /v1/member/access` derives scope only from that actor and evaluates one
  advisory-lock-protected, repeatable-read entitlement snapshot.
- `MemberActor.role` is resolved before the entitlement snapshot and can become
  stale during ownership transfer. The v1 dashboard therefore returns no
  membership role. A future role field must be selected or equality-validated
  inside the final lock-protected snapshot.
- customer tables are RLS-scoped through transaction-local `app.account_id`;
  the member role has no unscoped list operation.
- the only durable display fact needed here is `accounts.name`. There is no
  production member profile, onboarding, enrollment, progress, support,
  session, artifact, or Business OS lifecycle table yet.
- the demo dashboard's `DashboardView` and component tree assume Maria,
  Northstar, a lesson, two artifacts, Naomi's support reply, and a live session.
  Those assumptions cannot cross into production.
- the PRD next-best-step order is: access/payment blocker, customer reply owed
  to support, session within 48 hours, next required lesson, incomplete
  artifact, received feedback, optional community/commercial recommendation.
- the approved visual hierarchy remains the eventual target, but a missing
  module must render a real empty/unavailable state instead of a visually
  complete fixture.

The Next 16.3 repository guide confirms that pages/layouts are Server Components
by default, `"use client"` creates a client module-graph boundary, props crossing
that boundary must be serializable, and client-bundle imports must not contain
secrets. Fetch is uncached by default in this configuration, but this design
still sets `cache: "no-store"` explicitly at both browser and API boundaries.

## 3. Goals and non-goals

### Goals

- Prove a signed-in member can load only their account-scoped production facts.
- Reuse the entitlement authority; do not recompute capability rules in the
  route or web application.
- Replace the Wave 0 “access confirmed” terminal screen at `/learn` with a real,
  honest foundation dashboard.
- Define stable no-account, access-required, no-enrollment, and degraded
  behaviors.
- Reserve and fully constrain a v1 `ready` state for the first all-known-empty
  downstream snapshot, even though the foundation adapter cannot emit it.
- Establish a response shape that downstream modules can extend without
  keeping the demo repository as an adapter.
- Preserve no-store, no-demo-fallback, strict response validation, and
  correlation-ID behavior.

### Non-goals

- Creating, repairing, or claiming an account.
- Persisting onboarding answers or an onboarding-complete flag.
- Creating an enrollment or choosing a course version.
- Returning lesson metadata, progress percentage, resume position, artifacts,
  support messages, coach identity, session records, community content, or
  Business OS provisioning state.
- Adding a recommendation engine.
- Changing entitlement evaluation, grant semantics, or seat transitions.
- Returning an owner/teammate label from the pre-snapshot actor.
- Server-side rendering with a member token, installing `@clerk/nextjs`, or
  introducing a second member session.

## 4. Request and response contract

### 4.1 HTTP route

**Approved route alignment.** The route-contract ADR governs the member bearer,
actor-owned scope, no-store response, correlation, representation, and canonical
error behavior. The launch/acquisition plan separately fixes the exact
`GET /v1/member/dashboard` path. Together they resolve the endpoint-manifest
entry; do not add a second `/dashboard`, `/member/home`, query-selected account,
or Next Route Handler alias.

```http
GET /v1/member/dashboard
Authorization: Bearer <Clerk session token>
```

Request contract:

- query: exactly `{}`; `accountId`, `membershipId`, projection selectors, and
  unknown query keys return `400 VALIDATION_ERROR` before any repository call;
- body: exactly absent. A nonempty `Content-Length`, `Transfer-Encoding`, or
  parsed `request.body` returns `400 VALIDATION_ERROR` before authentication or
  any repository call;
- representation: absent `Syntholo-Dashboard-Version` or exact value `1`
  selects v1. Exact value `2` selects v2 only after v2 is deployed; any other,
  repeated, or comma-combined value returns `400 VALIDATION_ERROR`, and a valid
  `2` before deployment returns `406 NOT_ACCEPTABLE`, all before authentication;
- authentication: exactly the existing `authenticateMember` boundary;
- caching: success and error responses set `Cache-Control: no-store` and
  `Vary: Authorization, Syntholo-Dashboard-Version`;
- the route does not call `/v1/member/access` over HTTP. Both routes consume the
  same `member.access.getEffectiveAccess(actor)` port.

### 4.2 Contract schemas

Add `packages/contracts/src/member-dashboard.ts` and the explicit package export
`"./member-dashboard": "./src/member-dashboard.ts"`. API and web consumers,
especially the Client Component, import from
`@syntholo/contracts/member-dashboard`, not the package root. This keeps the
client graph on the narrow dashboard schema and makes the package subpath part
of the contract. The following is the exact v1 wire shape. All objects are Zod
`strict()` objects; all IDs are UUIDs. `generatedAt` must match
`YYYY-MM-DDTHH:mm:ss.sssZ`, parse to a finite instant, and equal
`new Date(value).toISOString()`.

```ts
const UtcMillisecondInstantSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const instant = new Date(value);
    return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
  });

const AccountNameSchema = z.string().superRefine((value, context) => {
  if (!isCanonicalAccountName(value)) {
    context.addIssue({ code: "custom", message: "Invalid account name" });
  }
});

type ProjectionUnavailableReason =
  | "module_not_implemented"
  | "dependency_unavailable";

type LearningProjection =
  | {
      state: "unavailable";
      reason: ProjectionUnavailableReason;
    }
  | {
      state: "empty";
      reason: "no_enrollment" | "no_required_lesson";
    };

type SupportProjection =
  | {
      state: "unavailable";
      reason: ProjectionUnavailableReason;
    }
  | {
      state: "empty";
      reason: "no_customer_response_due";
    };

type SessionProjection =
  | {
      state: "unavailable";
      reason: ProjectionUnavailableReason;
    }
  | {
      state: "empty";
      reason: "no_session_within_48_hours";
    };

type ImplementationProjection =
  | {
      state: "unavailable";
      reason: ProjectionUnavailableReason;
    }
  | {
      state: "empty";
      reason: "no_incomplete_artifact_or_feedback";
    };

type RecommendationProjection =
  | {
      state: "unavailable";
      reason: ProjectionUnavailableReason;
    }
  | {
      state: "empty";
      reason: "no_optional_recommendation";
    };

type MemberDashboardNextBestStep =
  | {
      kind: "access_blocker";
      reason: "academy_course_required";
      target: "program_options";
    }
  | {
      kind: "enrollment_blocker";
      reason: "academy_enrollment_missing";
      target: "retry";
    }
  | {
      kind: "unavailable";
      blockedBy:
        | "support"
        | "sessions"
        | "learning"
        | "implementation"
        | "recommendations";
      reason: ProjectionUnavailableReason;
      target: "retry";
    }
  | {
      kind: "none";
      reason: "no_action_available";
      target: null;
    };

type MemberDashboardResponse = {
  schemaVersion: 1;
  generatedAt: z.infer<typeof UtcMillisecondInstantSchema>;
  account: {
    id: string;
    name: z.infer<typeof AccountNameSchema>;
  };
  access: MemberAccessResponse;
  experience: {
    state: "access_required" | "no_enrollment" | "partial" | "ready";
  };
  projections: {
    learning: LearningProjection;
    support: SupportProjection;
    sessions: SessionProjection;
    implementation: ImplementationProjection;
    recommendations: RecommendationProjection;
  };
  nextBestStep: MemberDashboardNextBestStep;
};
```

Account names use one deliberately conservative, cross-runtime algorithm. The
canonical form is NFC, removes only leading/trailing ASCII SPACE (`U+0020`),
does not collapse internal ASCII spaces, is 1–255 UTF-8 bytes, and contains only
Unicode scalar values outside this exact forbidden set: `U+0000–U+001F`,
`U+007F–U+009F`, `U+00A0`, `U+00AD`, `U+061C`, `U+1680`, `U+180E`,
`U+2000–U+200F`, `U+2028–U+202F`, `U+205F–U+206F`, `U+3000`, `U+FEFF`,
`U+FDD0–U+FDEF`, every code point ending in `FFFE` or `FFFF`, and the surrogate
range `U+D800–U+DFFF`. Thus tab, LF, CR, NBSP, bidi/zero-width controls, invalid
surrogates, and Unicode noncharacters are rejected anywhere rather than
silently trimmed. Ordinary non-ASCII letters and symbols remain valid.

The contracts package owns these exact helpers; writers call the canonicalizer,
while response validation calls the predicate and never transforms storage:

```ts
function forbiddenAccountNameCodePoint(cp: number): boolean {
  return cp <= 0x1f
    || (cp >= 0x7f && cp <= 0x9f)
    || [0xa0, 0xad, 0x61c, 0x1680, 0x180e, 0x3000, 0xfeff]
      .includes(cp)
    || (cp >= 0x2000 && cp <= 0x200f)
    || (cp >= 0x2028 && cp <= 0x202f)
    || (cp >= 0x205f && cp <= 0x206f)
    || (cp >= 0xd800 && cp <= 0xdfff)
    || (cp >= 0xfdd0 && cp <= 0xfdef)
    || (cp & 0xffff) === 0xfffe
    || (cp & 0xffff) === 0xffff;
}

function canonicalizeAccountName(input: string): string {
  const value = input.normalize("NFC").replace(/^ +| +$/gu, "");
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (
    byteLength < 1
    || byteLength > 255
    || [...value].some((scalar) =>
      forbiddenAccountNameCodePoint(scalar.codePointAt(0)!))
  ) throw new Error("ACCOUNT_NAME_INVALID");
  return value;
}

function isCanonicalAccountName(value: string): boolean {
  try {
    return canonicalizeAccountName(value) === value;
  } catch {
    return false;
  }
}
```

Define these booleans in `superRefine`:

```ts
const academyMissing = !value.access.capabilities.academy_course;
const enrollmentMissing = !academyMissing
  && value.projections.learning.state === "empty"
  && value.projections.learning.reason === "no_enrollment";
const firstUnavailable = !academyMissing && !enrollmentMissing
  ? firstUnavailableProjection(value.projections)
  : null;
const partial = !academyMissing && !enrollmentMissing
  && firstUnavailable !== null;
const ready = !academyMissing && !enrollmentMissing
  && firstUnavailable === null;
```

Contract invariants are biconditional, not one-way implications:

1. `account.id === access.accountId`.
2. `experience.state === "access_required"` iff `academyMissing`.
3. `experience.state === "no_enrollment"` iff `enrollmentMissing`.
4. `experience.state === "partial"` iff `partial`.
5. `experience.state === "ready"` iff `ready`.
6. `nextBestStep.kind === "access_blocker"` iff the experience is
   `access_required`.
7. `nextBestStep.kind === "enrollment_blocker"` iff the experience is
   `no_enrollment`.
8. `nextBestStep.kind === "unavailable"` iff the experience is `partial`; its
   `blockedBy` and `reason` must equal the first unavailable projection in PRD
   order.
9. `nextBestStep.kind === "none"` iff the v1 experience is `ready`; every v1
   projection is then successfully known empty and learning is specifically
   `no_required_lesson`, not `no_enrollment`, and `target` is exactly `null`.
   Generic program browsing is page navigation outside `nextBestStep`.
10. arbitrary labels, rich text, URLs, provider payloads, grant provenance,
    Clerk IDs, member identity/role/email, and internal database
    status/timestamps are rejected.

The first deployed production adapter always emits
`{ state: "unavailable", reason: "module_not_implemented" }` for all five
projections. The `empty` variants exist for owning modules to use after a real
query proves absence. An adapter must never emit `empty` merely because its
table, provider, or query is missing.

The v1 `ready` state is valid but not emitted by the foundation adapter. It
becomes emittable when each v1 projection port has successfully proved its empty
condition, including learning `no_required_lesson`. Available downstream record
variants remain intentionally absent.

### 4.3 Representation negotiation and compatibility

`schemaVersion` is not negotiation by itself. The
`Syntholo-Dashboard-Version` rules in section 4.1 select a frozen representation
adapter while retaining the route ADR's ordinary JSON media type:

- absent or exact `1` always returns v1; exact `2` returns v2 only after the v2
  adapter is deployed and otherwise returns `406 NOT_ACCEPTABLE`;
- every successful response uses `Content-Type: application/json; charset=utf-8`
  and returns `Syntholo-Dashboard-Version: 1|2` matching the selected adapter;
- the body `schemaVersion` must equal that response header;
- `Vary: Authorization, Syntholo-Dashboard-Version` is present on every success
  and error so an
  intermediary cannot reuse one identity or representation for another.

When later modules return an available record internally, the frozen v1 adapter
continues to emit its safe foundation projection: the first such source is
`unavailable/module_not_implemented`, where `module_not_implemented` means “not
implemented by the selected representation adapter.” It does not emit an empty
projection or a lower-priority action. A v1 adapter may still emit `ready` only
when all five current module queries actually prove their v1 empty condition.
This is a lossy but authorization-safe fallback; existing v1 clients never see
a new union member.

Deployment order is mandatory:

1. ship version-header negotiation while only v1 exists; explicit v2 receives
   `406`;
2. ship web code that parses v1 and v2 but still requests the exact v1 media
   type;
3. ship the v2 API adapter and contract; default/v1 requests remain frozen v1;
4. switch the first-party web version header to `2` only after every API instance
   serves v2. Old/default v1 clients remain supported until a separate
   deprecation ADR and measured client-usage gate permit removal.

### 4.4 Success examples

An active account without Academy course access receives `200`, not `403`:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-14T16:00:00.000Z",
  "account": {
    "id": "10000000-0000-4000-8000-000000000001",
    "name": "Acme Advisory"
  },
  "access": {
    "accountId": "10000000-0000-4000-8000-000000000001",
    "capabilities": {
      "academy_course": false,
      "support": false,
      "circle_write": false,
      "operator_club": false,
      "business_os": false
    },
    "holds": [],
    "seatLimit": 3,
    "reservedSeats": 1,
    "explanations": [
      { "capability": "academy_course", "sourceGrantIds": [] },
      { "capability": "support", "sourceGrantIds": [] },
      { "capability": "circle_write", "sourceGrantIds": [] },
      { "capability": "operator_club", "sourceGrantIds": [] },
      { "capability": "business_os", "sourceGrantIds": [] }
    ]
  },
  "experience": { "state": "access_required" },
  "projections": {
    "learning": { "state": "unavailable", "reason": "module_not_implemented" },
    "support": { "state": "unavailable", "reason": "module_not_implemented" },
    "sessions": { "state": "unavailable", "reason": "module_not_implemented" },
    "implementation": { "state": "unavailable", "reason": "module_not_implemented" },
    "recommendations": { "state": "unavailable", "reason": "module_not_implemented" }
  },
  "nextBestStep": {
    "kind": "access_blocker",
    "reason": "academy_course_required",
    "target": "program_options"
  }
}
```

An entitled foundation account receives the same real account/access fields,
`experience.state = "partial"`, and:

```json
{
  "kind": "unavailable",
  "blockedBy": "support",
  "reason": "module_not_implemented",
  "target": "retry"
}
```

Support is named because it is the first currently unknown input after access.
The API does not skip to sessions, learning, or an optional recommendation.

### 4.5 Error contract and browser interpretation

All errors retain the existing `ApiErrorSchema` and correlation header.

| Condition | HTTP/code | Browser state | Rationale |
| --- | --- | --- | --- |
| Clerk not loaded | no request | `checking` | Wait for the configured provider. |
| Clerk signed out | no request | `signed_out` | Link to local `/sign-in`. |
| Malformed/repeated dashboard-version header | `400 VALIDATION_ERROR` | `degraded` | Reject before auth; the first-party client sends one allowlisted value. |
| Well-formed version `2` before v2 deployment | `406 NOT_ACCEPTABLE` | `degraded` | Never retry silently as v1; deployment ordering prevents this for first-party web. |
| Missing/malformed/expired Clerk bearer | `401 UNAUTHENTICATED` | `account_unavailable` | No auth bypass. |
| Valid Clerk user with no active account/membership mapping | `401 UNAUTHENTICATED` | `account_unavailable` | Existing identity boundary intentionally does not reveal mapping details. |
| Active actor, Academy capability false | `200` + `access_required` | `access_required` | The account exists; authorization is truthfully all-false/partial. |
| Active actor, Academy access true, real learning query proves no enrollment | `200` + `no_enrollment` | `no_enrollment` | Recovery state; do not invent an enrollment. |
| Repository-owned pool/query/parent/lock deadline sentinel | `503 DEPENDENCY_UNAVAILABLE` | `degraded` | Retry with correlation ID; never fall back to demo. Raw driver errors are not allowlisted. |
| Response fails strict schema/invariant validation | `500 INTERNAL_ERROR` | `degraded` | Treat a producer bug as unsafe data. |

The web cannot safely distinguish an expired/rejected bearer from a valid Clerk
identity that lacks a PostgreSQL actor because `authenticateMember` deliberately
collapses both to `401`. Therefore the UI must say “We could not connect this
sign-in to an active Syntholo member account,” not the stronger “you have no
account.” An exact `no_account` result requires the future claim flow to
authenticate a Clerk candidate before an internal `MemberActor` exists; that is
a commerce claim/onboarding contract, not a dashboard shortcut.

`503 DEPENDENCY_UNAVAILABLE` is the canonical API dependency error. It is
produced only from the typed, allowlisted translation in section 6. Unknown
errors, unexpected SQLSTATEs, malformed rows/snapshots, evaluator failures, and
contract/composition failures remain `500 INTERNAL_ERROR`, so programming or
integrity defects are not misclassified as ordinary degradation.

## 5. Data provenance by response field

| Response field | Source of truth | Projection rule |
| --- | --- | --- |
| `schemaVersion` | `@syntholo/contracts` | Literal `1`; never provider supplied. |
| `generatedAt` | API-injected clock | Capture only after final access revalidation; require canonical UTC millisecond serialization. |
| `account.id` | authenticated actor + `accounts.id` | Both must match; browser input cannot select it. |
| `account.name` | `accounts.name` through `AccountRepository.getById({ accountId }, accountId)` | Exact stored section 4.2 canonical value: NFC, ASCII-space edge canonicalization, explicit forbidden-code-point policy, and 1–255 UTF-8 bytes. Invalid stored data fails `500`; the read path neither transforms nor invents a fallback. |
| `access.*` | `MemberEntitlementReadRepository.getEffectiveAccess(actor)` and `evaluateEntitlements` | Reuse `MemberAccessResponseSchema` unchanged. |
| `experience.state` | pure dashboard composer | Derived from Academy capability plus typed learning availability; never persisted. |
| `projections.*` unavailable | selected version's composition registry | Literal `module_not_implemented` when that representation adapter has no typed available union, including the frozen v1 fallback. This is representation-capability metadata, not a claim that the global module/table is absent and not customer data. |
| `projections.*` empty | future account-scoped module query | Only after a successful authorized query proves absence. |
| `nextBestStep` | pure domain/application composer | Uses the PRD precedence and the unavailable barrier; labels and links remain web copy/routing. |

Notably absent:

- member first/last name, initials, title, or email;
- membership role; the pre-snapshot actor role is not current enough to expose;
- account category, country, timezone, website, goal, tools, priorities, or
  onboarding percentage;
- support expiration date (the current effective-access response exposes the
  boolean authority, not the underlying end date);
- progress percentage, completion count, lesson title/summary/stage, artifact
  titles, coach identity/message, or session metadata;
- provider IDs or provider status.

## 6. API composition and ordering

Add `apps/api/src/modules/member/get-dashboard.ts` and
`apps/api/src/routes/member/dashboard.ts`. Register it beside the existing
member-access route.

```ts
async function getMemberDashboard(
  actor: MemberActor,
  deps: DashboardDeps,
): Promise<MemberDashboardResponse> {
  // Informational read first. RLS scope still uses actor.accountId.
  const account = await deps.accounts.getById(
    { accountId: actor.accountId },
    actor.accountId,
  );
  if (!account) throw new MemberDashboardActorUnavailableError();

  // Authorization/revalidation MUST be the last database read before compose.
  const access = await deps.access.getEffectiveAccess(actor);

  // Timestamp only after final account/membership/access revalidation.
  const generatedAt = deps.clock.now();

  return MemberDashboardResponseSchema.parse(
    composeFoundationDashboard({ account, access, generatedAt }),
  );
}
```

The account and access reads must not run in parallel. The access repository
revalidates active account, membership, and actor under the entitlement account
lock. Running it last means a revocation/suspension that commits between the
informational account read and authorization read fails the request. If the
authorization snapshot wins before a concurrent writer, the response is
linearized before that writer. A concurrently renamed account may yield the
prior name for one response, which is acceptable informational staleness and
does not expand authority.

The response deliberately omits membership role. `authenticateMember` may have
resolved `actor.role` before a concurrent ownership transfer. The final
entitlement snapshot revalidates that the actor and membership are still active,
but it does not return or compare the current role. Passing `actor` into the
composer or serializing `actor.role` is therefore forbidden. If role is needed
later, extend the final lock-protected snapshot to return current membership
role and require equality with the actor before serialization.

Both ownership-transfer race orders are safe and must be preserved. If transfer
commits first, the final snapshot observes the still-active membership after the
transfer and the response contains no stale role. If the reader acquires the
shared account lock first, transfer waits; the response linearizes before the
writer and still contains no role. The next authenticated owner-sensitive
command resolves and authorizes the post-transfer role independently.

Do not make access the first read and then serialize an account row after it; a
suspension could commit in between and the route could answer after the
authorization revalidation point. Do not make internal HTTP calls between API
routes.

Route adapter behavior:

1. reject any GET body, validate the empty query, and select/reject the exact
   `Syntholo-Dashboard-Version` representation;
2. authenticate the member only after request-shape and representation
   validation;
3. call the use case;
4. map `MemberAccessUnavailableError` or actor/account disappearance to the
   existing `401 UNAUTHENTICATED` response;
5. map only `DatabaseDependencyUnavailableError` to canonical
   `503 DEPENDENCY_UNAVAILABLE` with the safe message “Service temporarily
   unavailable”;
6. let malformed data, unknown exceptions, and unexpected SQLSTATEs reach the
   safe handler as `500 INTERNAL_ERROR`;
7. parse the response and return it with no-store/vary headers.

Future module reads must be independently isolated only when safe. If a support
query fails, support becomes `dependency_unavailable`; it does not make an
Academy access decision fail. The next-best-step result nevertheless stops at
support because selecting a lower action would be unsound. Access failure is
never partial: the whole route is `503` because no member content may render
without current effective access.

### Bounded database deadlines and typed translation

Dashboard reads must not wait indefinitely for Neon, the pool, a query, or the
entitlement account lock. Production composition supplies validated finite
budgets with these launch defaults:

| Deadline | Default | Enforcement |
| --- | ---: | --- |
| Pool connection acquisition | 2,000 ms | repository-owned monotonic timer around `pool.connect()` |
| Any SQL query | 5,000 ms | repository-owned monotonic timer around the query promise; timeout poisons the lease |
| Shared entitlement advisory-lock acquisition | 2,000 ms total | poll `pg_try_advisory_lock_shared` outside the repeatable-read transaction; never use an unbounded blocking lock call |
| Entire account + access dependency phase | 8,000 ms | one absolute monotonic parent deadline propagated to both repositories |
| Rollback/unlock cleanup | 1,000 ms | bounded cleanup; destroy the client if not confirmed complete |

After the shared advisory lock is acquired, begin the repeatable-read/read-only
transaction so its snapshot is created after the writer exclusion point. Do
not begin the snapshot before waiting for the lock. Polling stops at the lock
deadline or parent deadline. The final unlock is verified exactly as in the
existing repository.

The database package owns four nominal sentinel classes whose constructors are
not exported outside its deadline helpers:

```ts
type MemberReadDeadlineKind =
  | "pool_acquire_timeout"
  | "query_timeout"
  | "parent_timeout"
  | "lock_timeout";

class MemberReadPoolAcquireDeadlineExceeded extends Error {
  readonly kind = "pool_acquire_timeout" as const;
}
class MemberReadQueryDeadlineExceeded extends Error {
  readonly kind = "query_timeout" as const;
}
class MemberReadParentDeadlineExceeded extends Error {
  readonly kind = "parent_timeout" as const;
}
class MemberReadLockDeadlineExceeded extends Error {
  readonly kind = "lock_timeout" as const;
}
```

`acquireMemberReadClient(pool, poolDeadline, parentDeadline)` starts its own
timer at the earlier absolute deadline and then calls `pool.connect()`. It
creates `MemberReadPoolAcquireDeadlineExceeded` when the pool budget wins and
`MemberReadParentDeadlineExceeded` when the parent wins. Because `pg.Pool`
8.23.0 exposes no public cancellation API for a queued checkout, the wrapper
keeps handlers on the original promise: a client delivered late is immediately
`client.release(true)` and a late rejection is consumed. The pool's
`connectionTimeoutMillis` remains a longer secondary resource guard, but its
untyped error is never inspected or translated. The repository timer, not a
driver message or option, creates the typed sentinel.

An acquired client is wrapped in a single-owner `MemberReadClientLease` with
idempotent `release()` and `destroy()` methods; repository `finally` blocks use
the lease, never call the raw release twice. `runMemberReadQuery(lease,
queryDeadline, parentDeadline, text, values)` races the raw query against its
own monotonic timer. The earlier absolute deadline determines whether the helper
creates `MemberReadQueryDeadlineExceeded` or
`MemberReadParentDeadlineExceeded`. When that timer wins it
first marks the lease poisoned, calls the installed driver's public typed
`PoolClient.release(true)`, consumes the raw query's later rejection, and only
then rejects with the sentinel. In installed `pg` 8.23.0, removal calls
`Client.end()` and destroys the socket when a non-pipelined query is active; the
server query cannot keep occupying a reusable pooled session. The lease installs
the public client `end` listener before release and awaits both that event and
settlement of the raw query promise, bounded by the 1,000 ms cleanup budget,
before the route may send its error. A missed acknowledgement is an
operations-visible driver invariant failure; the socket has already been
forcibly destroyed and is never reused. Do not use
unsupported query `AbortSignal`, the driver's internal `Client.cancel`, or
`query_timeout` as the cancellation mechanism or error classifier.

The operation-level parent deadline is an absolute `performance.now()` value,
not an `AbortSignal`. Both repositories pass it to every acquisition, lock poll,
query, and cleanup helper and call `throwIfMemberReadDeadlineExpired` before and
after non-query work. Advisory-lock polling creates
`MemberReadLockDeadlineExceeded` only when its own monotonic lock budget expires.
If a deadline fires while a client is acquired, or rollback/unlock is failed or
unconfirmed, the lease is destroyed and no further SQL is attempted on it.
Normal success confirms unlock before ordinary release.

At the repository boundary, `translateMemberReadDependencyError` has exactly
four `instanceof` allowlist entries: the pool-acquire, query, parent, and lock
sentinels. It wraps only those in the exported,
non-sensitive `DatabaseDependencyUnavailableError { kind }` that the route maps
to `503 DEPENDENCY_UNAVAILABLE`. Raw Node transport errors, raw
`connectionTimeoutMillis`/`query_timeout` errors, every raw `57014`, every
SQLSTATE including class `08`, `53300`, `57P01`–`57P03`, `42501`, `P0002`,
malformed rows, evaluator failures, and unknown exceptions are not on that
allowlist. `P0002` still follows its existing actor-unavailable translation to
`401`; all other unwrapped failures become `500`. No code or message matching
participates in 503 classification.

## 7. Persistence, repositories, and Unit of Work

### Persistence

No new dashboard/product table or column is justified. One backward-compatible
hardening migration is required because the current `accounts.name` column has
no canonical bound and `TransactionAccountRepository.rename` validates
`name.trim()` but currently stores the untrimmed input.

PostgreSQL must implement the exact section 4.2 predicate, not a locale-defined
`[:space:]`, `\s`, or “printable” regex. Add an immutable, strict SQL function
whose code-point denylist is byte-for-byte reviewed against the TypeScript
helper:

```sql
create function syntholo_account_name_is_canonical(value text)
returns boolean
language sql
immutable
strict
parallel safe
as $$
  select value = normalize(value, NFC)
     and value = btrim(value, ' ')
     and octet_length(value) between 1 and 255
     and not exists (
       select 1
       from generate_series(1, char_length(value)) as position(i)
       cross join lateral (
         values (ascii(substr(value, position.i, 1)))
       ) as scalar(cp)
       where scalar.cp <= 31
          or scalar.cp between 127 and 159
          or scalar.cp in (160, 173, 1564, 5760, 6158, 12288, 65279)
          or scalar.cp between 8192 and 8207
          or scalar.cp between 8232 and 8239
          or scalar.cp between 8287 and 8303
          or scalar.cp between 55296 and 57343
          or scalar.cp between 64976 and 65007
          or mod(scalar.cp, 65536) in (65534, 65535)
     )
$$;
```

PostgreSQL UTF-8 text cannot contain `U+0000` or unpaired surrogates; the
explicit numeric conditions keep the SQL predicate aligned with TypeScript for
all representable scalars. Migration `0008_account_name` must remain safe when
it is applied before new API writers and when the API is rolled back afterward.
The deployment sequence is:

1. add a `BEFORE INSERT OR UPDATE OF name` compatibility trigger that applies
   only the shared deterministic NFC plus ASCII-edge-space canonicalization;
   this lets pre-0008 writers and a rolled-back API continue to write valid
   names without weakening the constraint;
2. add the SQL predicate and an `accounts_name_canonical_check` constraint `NOT
   VALID`, so every new write is protected without pretending old rows were
   checked;
3. deterministically repair only existing NFC/ASCII-edge-space differences for
   which the resulting value passes the exact predicate. Preflight with that
   predicate and abort the entire migration if any blank, forbidden-code-point,
   or over-255-byte name remains; never guess or truncate a replacement;
4. validate the named constraint only after the preflight returns zero rows;
5. preserve the exact `0007_runtime_contract` result at
   `syntholo_runtime_readiness()` for old instances. New instances require that
   foundation projection plus additive, versioned
   `syntholo_account_name_readiness_v1()`, which attests the exact 0008 journal
   row/hash, predicate ownership, validated constraint, compatibility trigger,
   and ACLs without changing as future migrations are appended;
6. deploy the shared TypeScript canonicalizer to account creation/onboarding
   and `TransactionAccountRepository.rename`; each computes
   `canonicalizeAccountName(input)` once and persists that returned value, never
   the original input;
7. keep `AccountNameSchema` as the non-transforming response predicate, so
   malformed storage fails `500` rather than being silently repaired on read.

This is storage integrity hardening, not new feature persistence.

- `accounts.name` supplies the only display identity.
- the authenticated actor supplies account scope, but its role is not returned.
- entitlement grants/holds/seats already supply current access.
- module availability is deployment composition, not a database fact.
- the response is read-only and should not be cached as a durable projection.

Do not add a generic `dashboard`, `member_profile`, `onboarding_complete`,
`next_action`, `progress_summary`, or `recent_activity` table.

### Repository changes

Database repository implementation changes are required, but no new query
repository class or UoW surface is required. Reuse:

- `AccountRepository.getById({ accountId }, id)` for the scoped account row;
- `MemberEntitlementReadRepository.getEffectiveAccess(actor)` for authority.

Harden those reads as follows:

- configure the bounded connection/query/parent deadlines from section 6;
- replace the unbounded shared advisory-lock call in
  `MemberEntitlementReadRepository` with bounded `pg_try_advisory_lock_shared`
  polling;
- add the allowlisted `DatabaseDependencyUnavailableError` translator and
  client-disposal behavior;
- update every account-name writer to call the shared exact canonicalizer and
  rely on the same-code-point SQL check.

Add only a narrow API dependency interface so route tests can inject these
ports without receiving a raw pool or Drizzle builder. Production composition
constructs one `AccountRepository` on the member database alongside the
existing identity/access repositories.

When learning arrives, its owning plan adds an account-and-membership-scoped
read repository under RLS. It may return exactly one of `enrollment summary`,
`no enrollment`, or `dependency unavailable`; it must not be added to the
foundation transaction context prematurely.

### Unit of Work

No `TransactionContext` or Unit of Work change. The canonical UoW is a mutation
boundary for atomic domain writes, audit, and outbox. This dashboard performs no
mutation, so adding query-only dashboard repositories to it would enlarge the
write callback surface without providing atomicity.

No audit/outbox event is emitted for reading the dashboard. Access-decision
audit remains governed by operations that require a durable decision record;
ordinary page views belong to later consent-safe analytics, not the immutable
audit log.

## 8. Next-best-step composition

The composer is pure and server-owned. It receives already-authorized typed
projections and returns an action key/identifier, never display copy or an
arbitrary URL. The web maps targets to local routes.

Current algorithm:

1. If `academy_course` is false, return `access_blocker`.
2. If a real learning query returned `no_enrollment`, return
   `enrollment_blocker`. Missing enrollment is treated as access activation,
   before ordinary dashboard precedence.
3. Evaluate support. If unavailable, return `unavailable/support`; if a future
   available projection says the customer owes a reply, select it.
4. Evaluate sessions. If unavailable, return `unavailable/sessions`; if a
   future available projection contains a session starting in `[now, now+48h]`,
   select it.
5. Evaluate learning. If unavailable, return `unavailable/learning`; otherwise
   select the next required lesson when present.
6. Evaluate implementation. If unavailable, stop. Otherwise prefer incomplete
   artifact, then received feedback, matching the PRD.
7. Evaluate optional recommendations. If unavailable, stop. If it and every
   prior v1 projection are successfully known empty, emit `experience.ready`
   with `nextBestStep.none`. A later v2 contract adds typed available
   community/commercial actions; v1 never guesses one from absence.

Important rules:

- capability/hold computation stays entirely in the entitlement authority;
- `circle_write` false does not by itself remove read-only community access;
  the future Circle module owns that mapping;
- Business OS degradation never gates Academy or changes this sequence;
- support, session, and artifact records must be account/member scoped by their
  owning module before they can become “available” inputs;
- no default community recommendation is emitted from absence of data.

## 9. Next.js 16 client/server token boundary

### Required component boundary

```text
app/learn/page.tsx                    Server Component
  -> ProductionMemberDashboard       Client Component ("use client")
       -> useAuth/getToken
       -> createMemberApiClient
       -> validated JSON view props
       -> production presentation components
```

Rules:

1. `app/learn/page.tsx` remains synchronous/server by default and contains no
   Clerk token logic. In demo mode it may keep the current demo component; in
   production it renders only the client bootstrap.
2. `ProductionMemberDashboard` is the narrow `"use client"` root because
   `@clerk/react` exposes the current bearer in the browser. With the installed
   package, there is no approved server token bridge.
3. Call `getToken()` immediately before each request. Do not store the bearer
   in React state, context, local/session storage, a URL, or a cookie.
4. Use `createMemberApiClient`: relative `/v1/member/dashboard`,
   `credentials: "omit"`, `cache: "no-store"`, and exactly one Authorization
   header. Initially send `Syntholo-Dashboard-Version: 1`; the later version-
   switch deploy changes only that allowlisted value. Continue rejecting
   absolute, protocol-relative, and non-`/v1` paths.
5. Key in-memory response state by Clerk `sessionId`, abort in-flight fetch on
   session change/unmount, and ignore late results from the prior session.
6. Require ordinary JSON plus matching response
   `Syntholo-Dashboard-Version`/body `schemaVersion`, then parse with that
   version's dashboard schema. Invalid JSON, header/body mismatch, or invariant
   mismatch enters the degraded state; it never falls back to the demo
   repository.
   Import that schema from `@syntholo/contracts/member-dashboard`; do not import
   the client contract through `@syntholo/contracts`.
7. Only parsed plain JSON crosses from the fetch logic to presentational
   components. Do not pass a `Response`, token getter, Clerk user object,
   database object, or nonserializable value.
8. The production shell accepts `account.name` and effective access as props.
   It renders no owner/teammate label in v1 and must remove hard-coded `Maria
   Chen`, `MC`, `Northstar Advisory`, `Coaches online`, and support-expiration
   copy.
9. Because a Client Component imports everything it directly renders into the
   client graph, presentation modules imported below it must not import server
   config, `server-only` modules, database packages, or provider SDK secrets.
10. Keep privileged environment variables absent from Vercel web. The only
    member auth configuration exposed to the bundle remains the publishable
    Clerk key.

Do not add a Next Route Handler as a second backend-for-frontend. The existing
same-origin `beforeFiles` rewrite preserves Authorization to Fastify and avoids
credentialed CORS. A second handler would duplicate schema/error/cache logic and
create another token-bearing hop.

## 10. Authorized UI states

### Signed out

- No dashboard API request.
- Show “Sign in to continue” with local `/sign-in`.
- No production shell or account text.

### Signed in but no active internal actor (“no account”)

- API returns the existing collapsed `401`.
- Show “We could not connect this sign-in to an active Syntholo member
  account.”
- Offer one retry action. After the real commerce claim route exists, add a
  claim-specific action only when the claim API proves a pending claim.
- Never create an account, show a purchase, or label the user unpaid from this
  response.

### Account exists but Academy access is absent

- API returns `200 access_required` with the real account and effective-access
  explanation.
- Show a restricted state outside the full member navigation so links cannot
  lead into contained/demo feature pages.
- The only commercial action is a web-owned link to the real program-options
  surface. Until commerce offer availability exists, pricing remains
  informational and cannot create payment.

### Academy access exists but no enrollment

- This state is emitted only after the learning repository exists and an
  authorized query proves absence. The foundation adapter reports learning
  unavailable instead.
- Show “Academy setup is not complete” and a retry/correlation path.
- Do not pick the first lesson, derive zero percent, choose the latest course
  version, or insert an enrollment.
- Once commerce onboarding exists, its API may provide the exact resume action;
  the dashboard still does not own the transition.

### Entitled foundation-only dashboard

- Show account name, Academy access status, and reserved seats from the real
  response. Do not show a membership-role label in v1.
- Use a single unavailable panel for next-best-step content. Do not render empty
  Continue Learning, fake recommendations, coach rail, or session rail.
- The full visual hierarchy is progressively restored only as modules supply
  authorized available projections.

### Ready with no current action (reserved v1 state)

- Render only when every v1 projection query succeeded and proved its exact
  empty condition, with learning specifically `no_required_lesson`; the
  foundation adapter cannot emit this state.
- Show the real account/access shell and a neutral “No action is currently
  available” state. Its `nextBestStep.target` is `null`; an independently
  rendered generic program-navigation link may exist outside the
  next-best-step model.
- Do not infer completion, zero progress, onboarding completion, or an absent
  commercial/community opportunity from this state.
- Any future available record is a `schemaVersion: 2` response, accepted by the
  web before an owning API adapter may emit it.

### Degraded

- Network error, `5xx`, invalid JSON, or invalid contract enters one explicit
  state with retry and correlation ID when available.
- Do not render stale data from another Clerk session.
- Do not read demo fixtures, synthesize zeros, or persist a dashboard response
  in browser storage.
- A future isolated support/session outage can leave foundation account/access
  visible, but next-best-step remains blocked at the failed projection.

## 11. Commerce claim/onboarding preconditions

The following are upstream preconditions, not dashboard work:

1. Signed Stripe fulfillment creates the account, purchase-sourced grants,
   three-seat capacity, owner-course enrollment seed, claim token, audit, and
   outbox atomically before the buyer can claim.
2. Claim redemption verifies the Clerk/checkout email match, creates the member
   identity and owner membership, activates seat one, consumes the token, and
   reuses the already-created enrollment/grants. It never asks the dashboard to
   repair fulfillment.
3. Teammate invitation redemption must create or attach that member's learning
   enrollment according to the learning contract before sending them to the
   dashboard.
4. Resumable onboarding owns business name/details, timezone, team-size band,
   role/goal/tools, scorecard attachment, priorities, invitations, delivery
   schedule, current step, and completion timestamp. Do not add these to
   `accounts` ad hoc for dashboard copy.
5. The onboarding completion transition, not the dashboard, chooses when to
   land on `/learn`.
6. A mapped active member with effective Academy access but no enrollment is a
   fulfillment/claim consistency incident. The UI exposes a recoverable state;
   operations repair the owning records through an audited commerce/learning
   command.

Until those flows exist, a manually provisioned foundation account may reach
the partial dashboard, but the UI must not call that account fully onboarded.

## 12. Migration from demo types and components

### Stage 0 — containment (current Wave 0)

- Production `/learn/**` renders the access gate and no deterministic member
  shell/data.
- Demo mode remains an explicit prototype mode only.

### Stage 1 — foundation production dashboard (this slice)

- Add the strict v1 contract with the package `./member-dashboard` export, API
  use case/approved route, typed subpath-importing web fetcher, and
  `ProductionMemberDashboard` state machine.
- Add foundation presentation components that accept
  `MemberDashboardResponse`; do not make `DashboardView` a union with the new
  response and do not cast between them.
- Keep `MemberDashboard`, `DashboardContinueCard`,
  `DashboardRecommendationCard`, and `DashboardRightRail` demo-only.
- Refactor or add a production shell whose identity/status text comes solely
  from the response.

### Stage 2 — learning

- Learning adds a `schemaVersion: 2` `available` projection contract backed by
  enrollment-pinned course/version/progress queries. Follow section 4.3 exactly:
  deploy the dual parser while requesting v1, deploy the negotiated v2 adapter,
  then switch the web version header. Default and explicit-v1 clients retain
  the frozen safe v1 projection.
- Add a production Continue Learning adapter whose props are the new learning
  summary, not `DashboardView["nextLesson"]`.
- `progressPercent` exists only when the learning module defines numerator,
  denominator, and course-version provenance. No zero default.
- A successful no-row query may emit `no_enrollment`; module failure emits
  unavailable.

### Stage 3 — implementation artifacts and feedback

- Add independently typed artifact/review variants after account-shared,
  versioned persistence exists.
- Replace the demo recommendation cards only with server-selected, sourced
  actions. Do not look for required fixture kinds with non-null assertions.

### Stage 4 — support and sessions

- Add minimal waiting-on-customer support and within-48-hours session variants
  from their RLS repositories.
- Restore the right rail only when real cards exist. Empty projections omit the
  card rather than filling it with generic coach/session copy.

### Stage 5 — optional recommendation and demo removal

- Add Circle/commercial variants only after entitlement-to-Circle and offer
  availability contracts exist.
- Add a production static-import gate proving production route graphs cannot
  import `@/lib/demo/**` or demo domain selectors.
- Delete or archive `DashboardView` only when the explicit demo mode and its
  visual regression contract are retired. Do not use deletion as a prerequisite
  for the production slice.

This staged split preserves the approved visuals while preventing demo-centric
non-null assertions and fixture-rich component props from becoming the
production API model.

## 13. Verification plan

### Contract/unit tests

Add contract tests that prove:

- query and response objects are strict;
- `@syntholo/contracts/member-dashboard` resolves through the package
  `./member-dashboard` export and the web client has no root-contract import;
- `generatedAt` rejects offsets, missing/fractional non-millisecond precision,
  noncanonical dates, and non-`Z` timestamps;
- TypeScript and PostgreSQL account-name predicates agree for a generated valid-
  UTF-8 corpus and fixed cases: leading/trailing ASCII space canonicalizes on
  write but is rejected on response, internal ASCII space is preserved, NFC
  input is accepted, decomposed input canonicalizes on write but is rejected on
  response, and tab, LF, CR, NBSP, bidi/zero-width controls, and noncharacters
  are rejected; TypeScript additionally rejects unpaired surrogates before
  encoding because PostgreSQL text cannot represent them;
- exactly 255 UTF-8 bytes is accepted and 256 bytes is rejected using both
  one-byte and multibyte boundary strings; no writer truncates by code unit or
  byte;
- `account.id` must equal `access.accountId`;
- each experience/next-step pair satisfies both directions of its invariant;
- Academy false + `no_enrollment|partial|ready`, Academy true +
  `access_required`, learning `no_enrollment` + `partial|ready`, any unavailable
  projection + `ready`, and all-known-empty + `partial` are rejected;
- mismatched next-step negatives are rejected: access-required without
  access-blocker, non-access-required with access-blocker, no-enrollment without
  enrollment-blocker, non-no-enrollment with enrollment-blocker, partial without
  the matching first unavailable step, and ready without `none`;
- all successfully known-empty projections with learning
  `no_required_lesson` accept exactly `ready + none` with `target: null`;
- `none` with a browse/program target, a missing required `target`, or any
  non-null target is rejected; generic browse navigation is not composer data;
- absent/exact-`1` version header selects v1; exact `2` returns `406` before v2
  exists; unknown, repeated, or comma-combined values return `400`;
- after v2 exists, exact `2` selects v2 while absent/exact-`1` still returns
  strict v1; response version header, `schemaVersion`, and schema must match;
- source grant IDs retain the existing canonical ordering/uniqueness rules;
- internal account columns, Clerk IDs, email, provider fields, rich copy, and
  arbitrary hrefs are rejected;
- unavailable and empty cannot be confused.

Add pure composer tests for every precedence boundary:

- access blocker wins over everything;
- proven no-enrollment becomes the activation blocker;
- customer support response wins over session/lesson/artifact/feedback;
- a support failure blocks session/lesson selection;
- a session failure blocks lesson selection after support is proven empty;
- session exactly inside/outside 48 hours;
- lesson wins over artifact and feedback;
- incomplete artifact wins over received feedback;
- all v1 projections known empty produce `ready + none`;
- module-not-implemented and dependency-unavailable remain distinguishable.

The session/lesson/artifact/feedback selection tests are introduced alongside
their owning `available` contract variants; the foundation test suite covers
their unavailable barriers now. Optional recommendation selection is likewise
deferred until that response variant exists.

### API route/contract tests

Fastify injection tests must prove:

- empty query + one member bearer returns `200`, ordinary JSON, matching v1
  response header/body, `no-store`, and
  `Vary: Authorization, Syntholo-Dashboard-Version` by default;
- version-header negotiation happens before auth/repositories; explicit `1`
  remains v1 after v2 deployment, explicit `2` is `406` before deployment and
  v2 after it, and a response-header/body-version mismatch fails closed;
- a mixed-fleet rollout test keeps absent/explicit-`1` requests compatible on
  old and new API instances and proves the web's `2` switch is disabled until
  every instance passes the v2 readiness probe; the client never silently
  retries a `406` as v1;
- a GET body, `accountId`, or unknown query is rejected before auth and before
  every repository call;
- account repository receives exactly the actor account ID twice (scope and
  lookup), never a browser value;
- account read happens before access read, and the response is not produced if
  the final access revalidation fails;
- `generatedAt` is captured after the final access read and is canonical UTC-ms;
- neither dependency input nor response contains membership role;
- no actor, disappeared account, and `MemberAccessUnavailableError` return the
  existing secret-free `401`;
- Academy false returns a valid `200 access_required`, not a false-positive
  authorized dashboard;
- only one of the four wrapped repository deadline sentinels returns
  `503 DEPENDENCY_UNAVAILABLE`; body/header correlation IDs match, all error
  responses remain `no-store`/`Vary: Authorization, Syntholo-Dashboard-Version`,
  and no provider/SQL/URL/credential text is serialized or logged;
- malformed snapshots, invalid dependency output, unexpected SQLSTATEs, and
  arbitrary errors return `500` and do not leak rejected fields;
- duplicate/mixed/staff-cookie credentials remain rejected through the shared
  member authenticator.

Database-package unit tests with fake timers must prove the acquisition, query,
parent, and lock helpers each construct only their own nominal sentinel; a raw
error with identical name/message/kind does not pass `instanceof` translation.
They also prove late pool acquisition calls `release(true)` once, query/parent
expiry poisons and destroys the lease once, ordinary success releases once, and
raw driver `query_timeout`, `connectionTimeoutMillis`, `57014`, and transport
errors remain unwrapped.

### Real PostgreSQL tests

Use the disposable PostgreSQL integration configuration and actual member
runtime role to prove:

- two real member-runtime sessions scoped as account A and account B each
  receive only their own account name/access; this repository/RLS/API test is
  the authoritative cross-account isolation proof;
- changing the requested repository ID to account B returns no row under RLS;
- unset `app.account_id` returns no account row;
- active membership + active account resolves; revoked membership or suspended
  account fails final access revalidation and serializes no account name;
- entitlement grants/holds/seats in account B cannot affect account A's nested
  `access` result;
- back-to-back A/B reads on a one-connection pool do not leak transaction-local
  scope after success or rollback;
- suspension-first: account suspension commits before the reader's final lock/
  snapshot and the request returns `401` with no account serialization;
- reader-first suspension: the reader acquires the shared entitlement lock,
  returns a response linearized before the blocked writer, then suspension
  commits; the subsequent read returns `401`;
- membership-revocation-first and reader-first membership-revocation repeat the
  same two orderings and outcomes;
- ownership-transfer-first: transfer commits before the reader's final snapshot;
  the still-active member may receive access, but no stale role field exists;
- reader-first ownership transfer: the shared-lock reader completes before the
  transfer writer, and again serializes no role; a subsequent authentication
  resolves the new role for owner-sensitive commands;
- no row is inserted or updated by loading the dashboard.

Run deadline/error translation as separate real-PG tests, not as mocks of the
route:

- exhaust a one-client pool: the repository timer produces only
  `MemberReadPoolAcquireDeadlineExceeded` -> canonical `503`; a client delivered
  after the wrapper timeout is destroyed rather than returned to the pool;
- `pg_sleep` beyond the repository query budget produces only
  `MemberReadQueryDeadlineExceeded`, destroys the active
  socket through `release(true)`, and maps to canonical `503`;
- a parent deadline that wins before the per-query budget produces only
  `MemberReadParentDeadlineExceeded`, destroys an already acquired lease before
  acknowledgement, executes no later SQL, and maps to canonical `503`;
- a held exclusive entitlement advisory lock beyond 2,000 ms -> typed
  `lock_timeout` -> canonical `503`;
- built-in `connectionTimeoutMillis` and `query_timeout` failures, raw transport
  codes, raw `57014` (correlated or not), `42501`, class `08`, malformed
  snapshots, and unknown thrown errors remain `500`; no message/code classifier
  can manufacture a sentinel;
- deadline tests assert the raw query rejects/connection closes before the
  route completes; every parent/lock expiry observed after acquisition poisons
  the lease before bounded acknowledgement, no late SQL or retained advisory
  lock remains, and a following request on the pool succeeds, with
  canonical correlation/cache headers and no secret raw cause.

Existing entitlement evaluator property tests and member-access integration
tests stay in the focused regression set because the dashboard nests that
authority unchanged.

### Web unit tests

Mock `useAuth` and same-origin fetch to prove:

- loading and signed-out states issue no request;
- each signed-in invocation acquires a bearer, uses `credentials: omit` and
  `cache: no-store`, sends it only in Authorization, and sends the configured
  exact dashboard version header;
- v1 request/v1 response and v2 request/v2 response parse; response-header/body
  version mismatch, unrequested v2, and `406` render degraded without retrying
  under a different version or falling back to demo;
- session change aborts/ignores the previous request and clears its view;
- `401`, `access_required`, `no_enrollment`, `partial`, `ready`, `503`, network error,
  malformed JSON, and invariant failure render distinct safe states;
- no state contains Maria, Northstar, Naomi, fabricated initials, progress,
  coach-online, support-end, or session copy;
- the production shell gets account name/access only after a valid `200`
  response and never reads actor role;
- retry makes a fresh token request and does not reuse a stored bearer;
- demo repository methods are not called in production mode.

### Browser tests

Run desktop and mobile Playwright fixtures through the same-origin facade:

1. signed-out `/learn` -> local sign-in action;
2. signed-in Clerk session with no internal mapping -> collapsed account
   unavailable state and no fixture text;
3. mapped account without Academy grant -> real account/access-required state;
4. mapped entitled account -> partial foundation dashboard with real account,
   capability, and seat count only;
5. injected learning no-enrollment contract -> recovery state with no lesson;
6. API `503` -> retry/correlation state with no demo fallback;
7. two separately authenticated A/B browser contexts backed by the real API
   render only their own account; the authoritative denial remains the real
   member-role/RLS integration test above;
8. a synthetic account/access ID mismatch is rejected as client consistency
   defense only; it is not claimed as cross-account authorization proof;
9. sign-out/session switch while fetch is in flight -> prior account never
   renders;
10. keyboard order, visible focus, status announcements, axe scan, 44px mobile
   retry/sign-in actions, and no horizontal overflow;
11. request/response inspection proves relative `/v1/member/dashboard`, bearer
    header, ordinary JSON and matching request/response dashboard-version
    headers, no Cookie header, `Cache-Control: no-store`,
    `Vary: Authorization, Syntholo-Dashboard-Version`, matching
    body/header correlation ID on errors, and no token/database/provider secret
    in URL, body, browser storage, rendered copy, console, or captured server
    logs.

The legacy demo member journey and screenshot may continue only under explicit
demo configuration. It is not evidence for any production acceptance test.

The focused production browser journey builds and starts the web app with
`APP_MODE=production`, uses the real `ClerkProvider`/`useAuth` boundary, and
observes the same-origin bearer request. Its local HTTPS reverse proxy models
Vercel's deployment boundary by overwriting `x-vercel-id`, just as the platform
does before application code runs. Product code consumes that marker only when
server-owned `VERCEL=1` and `VERCEL_ENV=production` are both present and the
request URL is the explicitly ported loopback hop hidden behind the TLS proxy.
External request URLs—including Vercel preview aliases—are never reconstructed, so a
valid-looking client marker cannot suppress their canonical redirect. The app
never uses browser-supplied `Forwarded` or `X-Forwarded-*` values to defeat
canonical-host enforcement. Direct-spoof regression tests cover both the
external-alias and outside-platform cases.

## 14. Rollout and observability

1. Apply `0008_account_name` first: compatibility trigger, SQL predicate/`NOT
   VALID` check, deterministic repair, fail-closed preflight, validation, and
   additive readiness. Old instances continue to receive the exact 0007
   readiness result and old writers remain compatible. Then ship the shared
   canonicalizer to every writer before any dashboard API serializes names.
2. Ship the contracts subpath, bounded repository wrappers/sentinels, and v1 API
   route with version-header negotiation behind no UI consumer; verify Fastify/real-PG
   deadline, race, isolation, and default/explicit-v1 fallback tests.
3. Ship the web dual-version parser while it explicitly requests v1 and Wave 0
   remains the fallback for any non-200 response.
4. Switch only production `/learn` to the v1 client bootstrap; keep other
   `/learn/**` routes contained. A later v2 follows section 4.3's adapter-before-
   client-switch order and never changes the default v1 fallback.
5. Monitor route status/latency by low-cardinality code only. Do not log account
   name, Clerk bearer, grant IDs, member email, or response body.
6. Roll back the web consumer first if rendering fails. The read-only API route
   may remain safely unused. Migration 0008 remains compatible with the old API
   through its writer trigger and exact 0007 readiness surface. If 0008 itself
   must be rolled back, remove only its additive readiness function, wrapper/
   renamed-foundation indirection, trigger/function, and named constraint after
   web/API rollback, preserving canonicalized account values.

Recommended operational counters:

- `member_dashboard_requests_total{outcome=success|unauthenticated|unavailable|internal}`
- `member_dashboard_latency_ms`
- `member_dashboard_experience_total{state=access_required|no_enrollment|partial|ready}`

Do not emit `no_account` analytics from a collapsed `401`, and do not emit
`no_enrollment` until a real learning query proves that state.

## 15. Trade-offs and highest-risk decisions

### Risk 1 — collapsed `401` cannot prove “no account”

The current identity boundary correctly hides whether a Clerk user has a member
mapping. The web can provide a safe account-unavailable experience but cannot
truthfully diagnose “no account.” Splitting provider authentication from actor
resolution would support claim candidates, but that widens identity contracts
and belongs to commerce claim/onboarding.

**Ruling:** preserve the collapsed `401`; use non-assertive UI copy. Revisit only
with the claim-candidate contract.

### Risk 2 — missing high-priority modules can corrupt next-best-step selection

Treating unavailable as empty would make the dashboard recommend a lesson or
community action while an unanswered coach request or near-term session might
exist.

**Ruling:** unavailable is a precedence barrier. This makes the first dashboard
sparser, but it is the only result consistent with the PRD and current evidence.

### Risk 3 — account and entitlement reads are separate snapshots

A single aggregate database function would provide one snapshot but would
duplicate/expand the carefully reviewed entitlement security-definer surface.
Parallel or access-first reads introduce a revocation timing window.

**Ruling:** reuse the existing repositories, read informational account data
first, and make the advisory-lock-protected access call the final authorization
read. Revisit a unified snapshot only when measured latency or additional
foundation reads justify its security-review cost.

### Risk 3a — stale actor role across ownership transfer

The identity lookup happens before the final entitlement lock, so its role can
be stale in either transfer race order even while the membership remains active.

**Ruling:** omit membership role from v1 and keep the actor out of the response
composer. A later role field requires current role in, or equality validation
against, the final lock-protected snapshot.

### Risk 3b — broad availability translation can hide integrity defects

Mapping every database exception to `503` would turn RLS regressions, malformed
snapshots, and evaluator bugs into apparently routine outages. Unbounded or
timed-out advisory locks can also retain a pooled session lock.

**Ruling:** translate only repository-owned pool/query/parent/lock deadline
sentinels to `DEPENDENCY_UNAVAILABLE`; raw driver codes/messages never qualify.
Use the installed pg 8.23 `release(true)` destruction path for an active timed-
out lease. Unknown and malformed cases remain `500`.

### Risk 3c — body schema version alone does not protect old strict clients

Emitting a v2 union under the old unversioned response would make existing v1
clients fail validation, while silently mapping an available record to empty
could select an unsafe lower-priority action.

**Ruling:** negotiate the exact dashboard-version header while retaining
ordinary JSON, keep the frozen v1 safe projection as the absent-header default
throughout the compatibility period, and deploy dual-parser web -> v2 API ->
v2-requesting web in that
order. Removing v1 requires a later deprecation ADR and usage evidence.

### Risk 4 — a visually sparse dashboard may look unfinished

The approved design expects a Continue Learning card and human/session rail, but
those components currently require invented data.

**Ruling:** preserve typography, spacing, and state hierarchy, not fixture
density. Restore each card only with its owning production module.

### Risk 5 — no-enrollment could become an accidental repair path

Creating an enrollment from the dashboard would bypass purchase/claim
idempotency, course-version pinning, seats, audit, and fulfillment invariants.

**Ruling:** no-enrollment is read-only and recoverable; commerce/learning owns an
audited repair command. The foundation adapter cannot assert no-enrollment.

### Risk 6 — demo types could become the accidental production contract

`DashboardView` embeds fixture-centric non-null assumptions and route strings.
Adapting production data into it would silently manufacture required lessons,
coach replies, and artifacts.

**Ruling:** parallel production contract/components first; migrate card by card
as module-owned data appears. No casts between `DashboardView` and
`MemberDashboardResponse`.

## 16. Acceptance criteria

- `GET /v1/member/dashboard` accepts no caller scope and returns only the
  authenticated actor's account.
- account/access authorization is backed by existing member actor mapping,
  scoped repository/RLS, and the entitlement authority.
- a missing/invalid actor returns the existing collapsed `401`; the UI does not
  overclaim that an account does not exist.
- Academy false, proven no-enrollment, dependency degradation, and foundation
  partial/ready states are visibly and contractually distinct and satisfy
  biconditional response invariants.
- all absent downstream modules are unavailable, not fabricated and not
  silently empty.
- next-best-step never crosses an unavailable higher-priority projection.
- `nextBestStep.none` has exactly `target: null`; generic browse navigation is
  outside the next-best-step contract.
- no new product table/column or UoW surface is added; account-name canonical
  storage/check hardening and bounded repository reads are completed first.
- TypeScript writers/schema and PostgreSQL use the same NFC, ASCII-edge-space,
  code-point, and 1–255 UTF-8-byte account-name algorithm.
- membership role is absent from v1 and both ownership-transfer race orders are
  covered.
- only the four repository-owned deadline sentinels map to canonical
  `503 DEPENDENCY_UNAVAILABLE`; raw pg/network errors, malformed/unknown failures
  remain `500` and timed-out/ambiguous clients are destroyed.
- default and explicit-v1 requests retain the frozen v1 representation after v2
  deployment; only exact header value `2` can receive v2, with matching response
  header/body version and the ordered rollout/tests in section 4.3.
- `@syntholo/contracts/member-dashboard` is an explicit package export and the
  client uses that subpath.
- the Clerk bearer stays within the narrow browser client -> same-origin `/v1`
  request boundary and is never stored.
- production rendering contains no demo account/member/lesson/artifact/support/
  session data and never falls back to fixtures.
- contract, API, real PostgreSQL/RLS, web, accessibility, and desktop/mobile
  browser tests cover the states and races listed above.

## 17. What to revisit as the system grows

- Add real `available` projection variants one owning module at a time.
- Consider a unified read snapshot only after at least two additional
  foundation repositories are required and its RLS/security-definer review is
  budgeted.
- Consider server-rendered member data only if Syntholo adopts an official
  server-capable Clerk/Next integration with an explicit token-forwarding
  threat model; do not leak the current bearer into RSC props to gain SSR.
- Add route-aware refresh after mutations when progress/support/session modules
  land; keep no-store as the authorization default.
- Replace the enrollment retry target with a commerce-owned onboarding/claim
  resume action only after that API can prove the exact next step.
