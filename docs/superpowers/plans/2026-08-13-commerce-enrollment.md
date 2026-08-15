# Commerce and Enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement native lead/application capture, Self-Paced and private Pilot checkout, idempotent Stripe fulfillment, account claims, three-seat enrollment, Operator Club renewal, and refund/dispute/cancellation handling that changes only transaction-sourced grants.

**Architecture:** Stripe remains the financial authority while PostgreSQL owns offers, fulfillment, claims, cohorts, and access-source records. Public commands capture attribution and create Checkout sessions; raw signed webhooks are claimed once and converted into atomic purchase/grant/outbox mutations. All money reversals call the entitlement authority and preserve accounts, progress, certificates, financial records, and audit history.

**Tech Stack:** Fastify, Zod, Drizzle/PostgreSQL, Stripe Checkout and Billing, Clerk claim flow, Resend jobs, Next.js App Router, Vitest, PostgreSQL integration tests, and Playwright.

## Global Constraints

- This plan starts only after `npm run gate:foundation` passes.
- Stripe event IDs, Checkout session IDs, payment intent IDs, refund IDs, invoice IDs, and dispute IDs are unique database keys.
- Webhook signature verification uses raw bytes before JSON parsing; replay returns `200` without applying fulfillment twice.
- Self-Paced payment remains blocked until `ContentLaunchReadiness.canSellAcademy === true`.
- Guided Pilot requires approved application, cohort capacity, and an unexpired single-use private checkout authorization.
- Purchaser claim tokens are single-use, seven-day, hashed at rest, and require a verified Clerk email matching the checkout email.
- One paid Academy source creates three-seat capacity with zero occupied rows;
  owner claim activates slot one and pending teammate invitations reserve slots
  two and three.
- Business OS never creates Academy or Operator Club grants. Its $999 setup
  payment creates a zero-grant financial/provisioning receipt; only the recurring
  subscription lifecycle creates the finite `business_os` grant.
- Full Academy refund is unconditionally available for seven days subject to law; the same policy version appears in sales, Pilot email, Checkout, and terms.
- Open disputes hold new purchases, seat changes, and Business OS activation while preserving existing learning access until the dispute result.
- Never delete achievement, progress, account, financial, or audit history during refund/cancellation/dispute processing.

## Planned File Map

- `packages/contracts/src/commerce/**` — offers, checkout, webhook, claim, billing, refund/dispute contracts.
- `packages/domain/src/commerce/**` — offer availability, money state transitions, refund policy.
- `packages/domain/src/applications/**` — Pilot review and cohort capacity rules.
- `packages/database/src/schema/{commerce,applications}.ts` — financial/application records.
- `packages/database/src/repositories/{commerce,applications,claims,seats}.ts` — transactional persistence.
- `packages/integrations/src/stripe/**` — Stripe port and adapter.
- `apps/api/src/routes/{public,member,staff,webhooks}/**` — protected route adapters.
- `apps/api/src/modules/{commerce,applications,claims}/**` — use cases.
- `apps/worker/src/handlers/commerce/**` — email and deferred billing actions.
- `apps/web/src/app/{scorecard,pricing,checkout,claim}/**` — native public/claim UI.
- `apps/web/src/app/admin/{applications,cohorts,commerce}/**` — staff operations UI.

---

### Task 1: Model offers, prices, availability, and the payment gate

**Files:**
- Create: `packages/domain/src/commerce/{offers,availability}.ts`
- Create: `packages/domain/src/commerce/availability.test.ts`
- Create: `packages/contracts/src/commerce/offers.ts`
- Create: `packages/database/src/schema/commerce.ts`
- Create: `packages/database/drizzle/0014_commerce_catalog.sql`
- Create: `packages/database/src/repositories/offers.ts`
- Create: `apps/api/src/routes/public/offers.ts`

**Interfaces:**
- Produces `OfferCode = "scorecard" | "guided_pilot" | "self_paced" | "operator_club_monthly" | "operator_club_annual" | "business_os"`.
- Consumes `ContentLaunchReadiness = { requiredLessons: 18; readyLessons: number; contentHash: string; automatedPassedAt: string | null; humanApprovedAt: string | null; canSellAcademy: boolean }` from the master/content plan.
- Produces `evaluateOfferAvailability(offer, context): { available: boolean; reasonCode: string | null; startsAt: Date | null }`.

- [ ] **Step 1: Write the offer-matrix test**

```ts
it("blocks Academy payment until automated and human curriculum gates pass", () => {
  const blocked = evaluateOfferAvailability(selfPaced, context({ readyLessons: 18, humanApprovedAt: null }));
  expect(blocked).toEqual({ available: false, reasonCode: "CURRICULUM_GATE_BLOCKED", startsAt: null });
});

it("does not make Business OS imply Academy access", () => {
  expect(capabilitiesCreatedBy("business_os")).toEqual(["business_os"]);
});
```

- [ ] **Step 2: Run RED**

Run `npm test -w @syntholo/domain -- src/commerce/availability.test.ts`.

Expected: FAIL because the offer model does not exist.

- [ ] **Step 3: Implement the catalog and server-side availability evaluator**

Store Stripe price IDs by environment in `offer_prices`; store offer state as `draft | waitlist | enabled | paused`. Return public display data without provider IDs. Academy requires the content gate; Pilot Checkout additionally requires application authorization; Operator Club requires effective Academy course access; Business OS requires a separate operational-readiness flag.

```ts
export function evaluateOfferAvailability(offer: Offer, context: OfferContext): OfferAvailability {
  if (offer.state !== "enabled") return { available: false, reasonCode: "OFFER_DISABLED", startsAt: null };
  if (isAcademy(offer.code) && !context.content.canSellAcademy) {
    return { available: false, reasonCode: "CURRICULUM_GATE_BLOCKED", startsAt: null };
  }
  if (isOperatorClub(offer.code) && !context.access.capabilities.academy_course) {
    return { available: false, reasonCode: "ACADEMY_REQUIRED", startsAt: null };
  }
  if (offer.code === "business_os" && !context.businessOsReady) {
    return { available: false, reasonCode: "BUSINESS_OS_NOT_READY", startsAt: null };
  }
  return { available: true, reasonCode: null, startsAt: null };
}
```

- [ ] **Step 4: Run GREEN and API contract tests**

Run `npm test -w @syntholo/domain && npm test -w @syntholo/api -- offers`.

Expected: each offer denial has a stable reason code.

- [ ] **Step 5: Commit**

```bash
git add packages apps/api
git commit -m "feat: model production offer availability"
```

### Task 2: Persist attribution, scorecard leads, and Pilot applications

**Files:**
- Create: `packages/contracts/src/commerce/{attribution,applications}.ts`
- Create: `packages/domain/src/applications/review.ts`
- Create: `packages/domain/src/applications/review.test.ts`
- Create: `packages/database/src/schema/applications.ts`
- Create: `packages/database/drizzle/0015_applications.sql`
- Create: `apps/api/src/routes/public/{scorecards,pilot-applications}.ts`
- Create: `apps/api/src/modules/applications/{submit,review}.ts`
- Modify: `apps/web/src/features/scorecard/scorecard-client.tsx`
- Create: `apps/web/src/app/pilot/apply/page.tsx`

**Interfaces:**
- Produces `AttributionInputSchema` with first/last touch `source`, `medium`, `campaign`, `content`, `landingPath`, and consent timestamp; no raw ad-platform identifier is required.
- Produces `POST /v1/public/scorecards` and `POST /v1/public/pilot-applications` with rate limiting and idempotency keys.
- A Scorecard creates a consent/lead/report record only; it never creates an account, purchase, seat, enrollment, or entitlement grant.
- Produces application states `submitted | needs_information | approved | declined | checkout_sent | purchased`.

- [ ] **Step 1: Write failing scoring/application validation tests**

Reject missing required consent decision, malformed campaign fields, oversized free text, and illegal `submitted → checkout_sent` transition.

```ts
it.each([
  [{ marketingConsent: undefined }, "marketingConsent"],
  [{ attribution: { source: "x".repeat(161) } }, "source"],
  [{ goals: "x".repeat(5_001) }, "goals"],
])("rejects invalid application input", (patch, field) => {
  const result = PilotApplicationInputSchema.safeParse({ ...validApplication(), ...patch });
  expect(result.success).toBe(false);
  expect(result.error?.issues.some((issue) => issue.path.includes(field))).toBe(true);
});

it("does not skip review", () => {
  expect(() => transitionApplication(application("submitted"), "checkout_sent")).toThrow("INVALID_APPLICATION_TRANSITION");
});

it("creates no commercial access from a Scorecard", async () => {
  await submitScorecard(validScorecardCommand(), deps);
  expect(await counts(db, ["purchases", "entitlement_grants", "seat_reservations", "enrollments"])).toEqual([0, 0, 0, 0]);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/applications && npm test -w @syntholo/api -- applications`

Expected: public persistence routes are missing and current scorecard is browser-only.

- [ ] **Step 3: Implement scoped lead/application writes and sanitization**

Store marketing consent separately from transactional permission; default it to false. Normalize attribution strings to 160 characters and never send applicant text to PostHog.

```ts
export async function submitPilotApplication(command: SubmitPilotApplication, deps: ApplicationDeps) {
  const input = PilotApplicationInputSchema.parse(command.input);
  return deps.uow.transaction(async (tx) => {
    const application = await tx.applications.insert({
      ...input,
      marketingConsent: input.marketingConsent === true,
      attribution: normalizeAttribution(input.attribution),
      status: "submitted",
    });
    await tx.audit.append(applicationSubmittedAudit(application, command.context));
    await tx.outbox.enqueue(applicationSubmittedEvent(application));
    return application;
  });
}
```

Also add `GET /v1/public/scorecards/:reportToken`, where `reportToken` is random, hashed at rest, expires after seven days, and returns the scored report without exposing applicant data.

- [ ] **Step 4: Wire the current scorecard and new Pilot application UI**

Use the typed API client, preserve the approved public design, show correlation IDs on recoverable submission errors, and retain an unsent draft in browser storage labeled as unsynced.

```tsx
export function PilotApplicationForm({ api }: { api: PublicApplicationsApi }) {
  const [status, submit] = useDurableFormDraft("pilot-application", api.submitPilotApplication);
  return (
    <form onSubmit={submit}>
      <PilotApplicationFields />
      <MarketingConsentCheckbox defaultChecked={false} />
      <Button type="submit">Submit application</Button>
      <p role="status">{submissionStatusCopy(status)}</p>
    </form>
  );
}
```

- [ ] **Step 5: Run GREEN**

```bash
npm test -w @syntholo/domain -- applications
npm test -w @syntholo/api -- applications
npm test -w @syntholo/web -- scorecard
```

Expected: duplicate idempotency keys return the original record and only one audit event exists.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: persist scorecards and Pilot applications"
```

### Task 3: Create signed public and private Stripe Checkout sessions

**Files:**
- Create: `packages/integrations/src/stripe/{port,adapter}.ts`
- Create: `packages/integrations/src/stripe/adapter.test.ts`
- Create: `apps/api/src/modules/commerce/create-checkout.ts`
- Create: `apps/api/src/routes/public/checkouts.ts`
- Create: `apps/api/src/modules/commerce/create-checkout.integration.test.ts`
- Modify: `apps/web/src/app/checkout/[offer]/page.tsx`
- Modify: `packages/integrations/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes `StripePort.createCheckoutSession(command)`; returns provider session ID and URL only.
- Produces `POST /v1/public/checkouts` for Self-Paced and enabled Business OS.
- Produces `POST /v1/public/pilot-checkouts/:authorizationToken` for a single approved cohort assignment.
- Sends internal `checkoutAuthorizationId`, `offerCode`, `priceId`, `applicationId?`, and attribution ID in signed Stripe metadata; price/amount from browser input is ignored.

- [ ] **Step 1: Write checkout authorization RED tests**

Cover curriculum blocked, Business OS not ready, Pilot not approved, Pilot cohort full, expired authorization, replayed authorization, wrong offer, and valid cases.

```ts
it.each([
  ["self_paced", context({ curriculumReady: false }), "CURRICULUM_GATE_BLOCKED"],
  ["business_os", context({ businessOsReady: false }), "BUSINESS_OS_NOT_READY"],
  ["guided_pilot", context({ pilotAuthorization: "expired" }), "AUTHORIZATION_EXPIRED"],
])("blocks unauthorized checkout", async (offerCode, context, code) => {
  await expect(createCheckout(command({ offerCode }), deps(context))).rejects.toMatchObject({ code });
  expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/integrations -- stripe && npm run test:integration -w @syntholo/api -- create-checkout.integration.test.ts`

Expected: current Checkout is a deterministic demo and no server command exists.

- [ ] **Step 3: Implement the Stripe port and command**

Load price and amount from the server catalog. Set Stripe automatic tax/receipt behavior from approved configuration, include the exact refund/recurring disclosure version, and use the request idempotency key for Stripe creation.

```ts
export interface StripePort {
  createCheckoutSession(command: {
    priceId: string;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }>;
}

export async function createCheckout(command: CreateCheckout, deps: CheckoutDeps) {
  const offer = await deps.offers.getEnabled(command.offerCode);
  assertAvailable(evaluateOfferAvailability(offer, await deps.context.load(command)));
  return deps.stripe.createCheckoutSession({
    priceId: offer.stripePriceId,
    customerEmail: command.email,
    successUrl: deps.urls.claim,
    cancelUrl: deps.urls.offer(offer.code),
    metadata: checkoutMetadata(command, offer),
    idempotencyKey: command.context.idempotencyKey,
  });
}
```

```bash
npm install stripe -w @syntholo/integrations
```

- [ ] **Step 4: Wire Checkout UI and error states**

The page requests a session, renders the policy disclosure before redirect, and displays `OFFER_UNAVAILABLE`, `CURRICULUM_GATE_BLOCKED`, or `AUTHORIZATION_EXPIRED` without inventing access.

```tsx
async function CheckoutPage({ params }: PageProps<"/checkout/[offer]">) {
  const { offer } = await params;
  const availability = await publicApi.getOffer(offer);
  return <CheckoutPanel offer={availability} disclosure={<AcademyRefundDisclosure />} />;
}

const CHECKOUT_ERROR_COPY = {
  OFFER_UNAVAILABLE: "This offer is not available right now.",
  CURRICULUM_GATE_BLOCKED: "Enrollment is not open yet.",
  AUTHORIZATION_EXPIRED: "This private checkout link has expired.",
} as const;
```

- [ ] **Step 5: Run GREEN**

Run: `npm test -w @syntholo/integrations -- stripe && npm run test:integration -w @syntholo/api -- create-checkout.integration.test.ts && npm test -w @syntholo/web -- checkout`

Expected: PASS with the fake Stripe port; request assertions show no browser-supplied price ID or amount.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: create authorized Stripe checkouts"
```

### Task 4: Process raw signed Stripe webhooks exactly once

**Files:**
- Create: `apps/api/src/routes/webhooks/stripe.ts`
- Create: `apps/api/src/modules/commerce/process-stripe-event.ts`
- Create: `apps/api/src/modules/commerce/fulfill-purchase.ts`
- Create: `apps/api/src/modules/commerce/fulfill-purchase.integration.test.ts`

**Interfaces:**
- Consumes `POST /v1/webhooks/stripe` raw body and `stripe-signature`.
- Produces event receipt state `claimed | processed | failed_retryable | failed_terminal`.
- On `checkout.session.completed`, atomically creates purchase, account,
  source-linked grants, support window, three-seat capacity with zero occupied
  reservation rows, enrollment seed, claim token hash, audit, and outbox events.

- [ ] **Step 1: Write invalid-signature and replay RED tests**

```ts
it("fulfills one purchase for repeated delivery", async () => {
  await postStripe(event("evt_same"));
  await postStripe(event("evt_same"));
  expect(await db.query.purchases.findMany()).toHaveLength(1);
  expect(await db.query.entitlementGrants.findMany()).toHaveLength(3);
  expect(await db.query.outboxEvents.findMany({ where: purchaseFulfilled })).toHaveLength(1);
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test:integration -w @syntholo/api -- fulfill-purchase.integration.test.ts`

Expected: API route missing; no production fulfillment transaction exists.

- [ ] **Step 3: Implement raw signature verification and receipt claim**

Claim `(provider, event_id)` before mutation. A duplicate processed event returns `200`; a duplicate in-progress receipt is not concurrently fulfilled. Unknown event types are acknowledged and recorded without mutation.

```ts
app.post("/v1/webhooks/stripe", { config: { rawBody: true } }, async (request, reply) => {
  const event = deps.stripe.constructEvent(request.rawBody, request.headers["stripe-signature"]);
  const claim = await deps.receipts.claim("stripe", event.id);
  if (claim === "processed") return reply.code(200).send({ received: true });
  await deps.events.process(event);
  await deps.receipts.complete("stripe", event.id);
  return reply.code(200).send({ received: true });
});
```

Use the foundation's `fastify-raw-body` plugin only for signed webhook routes; ordinary JSON routes retain parsed bodies.

- [ ] **Step 4: Implement offer-specific fulfillment**

Self-Paced and Pilot create Academy course/support/Circle sources; Pilot also
creates cohort enrollment. Business OS setup fulfillment records its immutable
zero-grant receipt and provisioning/reconciliation state. Only an authoritative
recurring subscription event creates finite Business OS access. Operator Club is
handled by subscription events in Task 8.

```ts
export const FULFILLMENT_CAPABILITIES: Record<PurchasableOfferCode, readonly GrantCapability[]> = {
  self_paced: ["academy_course", "support", "circle_write"],
  guided_pilot: ["academy_course", "support", "circle_write"],
  business_os: [], // setup payment is a zero-grant receipt
};

export function grantsForPurchase(purchase: Purchase): readonly NewEntitlementGrant[] {
  return FULFILLMENT_CAPABILITIES[purchase.offerCode].map((capability) =>
    grantFromPurchase(purchase, capability, capability === "academy_course" ? null : addMonths(purchase.paidAt, 12)),
  );
}
```

- [ ] **Step 5: Run GREEN with transaction-failure replay**

Force a failure between purchase and grants; assert the transaction rolls back, receipt is retryable, and a later replay creates exactly one complete fulfillment.

Run: `npm run test:integration -w @syntholo/api -- fulfill-purchase.integration.test.ts`

Expected: PASS with one purchase, one complete grant set, one claim token, and one fulfillment event after replay.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: fulfill Stripe purchases idempotently"
```

### Task 5: Implement account claim and owner onboarding

**Files:**
- Create: `packages/contracts/src/commerce/claims.ts`
- Create: `packages/database/src/repositories/claims.ts`
- Create: `apps/api/src/modules/claims/{inspect,redeem}.ts`
- Create: `apps/api/src/routes/member/claims.ts`
- Create: `apps/api/src/modules/claims/redeem.integration.test.ts`
- Modify: `apps/web/src/app/claim/page.tsx`
- Create: `apps/web/src/app/onboarding/page.tsx`

**Interfaces:**
- Produces anonymous rate-limited `POST /v1/public/claims/initiate` that hashes/validates the raw link token, sets a Secure/HttpOnly/SameSite=Strict seven-day `pending_claim` cookie, and returns a non-sensitive offer/business preview plus `/sign-in?redirect_url=/claim`. The raw token is removed from browser history before Clerk navigation.
- Produces `GET /v1/member/claims/pending` and `POST /v1/member/claims/pending/redeem`; both resolve the pending claim from the cookie, never a path/query token.
- Consumes a Clerk-authenticated `MemberActorCandidate` and verified primary email; internal `MemberActor` is created only after redemption.
- Token is 32 random bytes, stored only as SHA-256 hash, expires in seven days, and is consumed atomically.

- [ ] **Step 1: Write claim security RED tests**

Cover wrong email, unverified email, expired token, token replay, token for already claimed purchase, simultaneous redemption, and valid owner claim.

```ts
it.each([
  [actorCandidate({ email: "wrong@example.com" }), "CLAIM_EMAIL_MISMATCH"],
  [actorCandidate({ emailVerified: false }), "VERIFIED_EMAIL_REQUIRED"],
])("rejects an invalid claimant", async (candidate, code) => {
  await expect(redeemClaim(command({ candidate }), deps)).rejects.toMatchObject({ code });
});

it("allows only one concurrent redemption", async () => {
  const results = await Promise.allSettled([redeemClaim(validCommand, deps), redeemClaim(validCommand, deps)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test:integration -w @syntholo/api -- redeem.integration.test.ts`

Expected: current claim screen uses demo state.

- [ ] **Step 3: Implement inspect/redeem transactions**

The successful transaction creates member identity, owner membership, activates seat one, consumes token, and emits `identity.account_claimed.v1`. It does not issue new entitlements.

```ts
export async function redeemClaim(command: RedeemClaim, deps: ClaimDeps): Promise<MemberActor> {
  return deps.uow.transaction(async (tx) => {
    const claim = await tx.claims.lockByHash(sha256(command.token));
    assertClaimable(claim, command.candidate, deps.clock.now());
    const actor = await tx.identities.createOwnerFromClaim(claim, command.candidate);
    await tx.seats.activateOwnerSeat(claim.accountId, actor.membershipId);
    await tx.claims.consume(claim.id, deps.clock.now());
    await tx.outbox.enqueue(accountClaimedEvent(actor));
    return actor;
  });
}
```

- [ ] **Step 4: Wire Clerk sign-in and onboarding UI**

After sign-in, request a short-lived API token, redeem the claim, collect business display/timezone fields, and continue to `/learn`. Never put the claim token in analytics.

```tsx
export function ClaimPanel({ token }: { token: string }) {
  const { getToken, isSignedIn } = useAuth();
  const redeem = async () => memberApi(await getToken()).redeemPendingClaim();
  return isSignedIn
    ? <Button onClick={() => void redeem()}>Claim my account</Button>
    : <Button onClick={() => void initiateClaimAndSignIn(token, { replaceHistory: true, redirectUrl: "/claim" })}>Sign in to claim</Button>;
}
```

- [ ] **Step 5: Run GREEN**

Run: `npm run test:integration -w @syntholo/api -- redeem.integration.test.ts && npm run test:e2e -w @syntholo/web -- claim.spec.ts`

Expected: PASS in desktop/mobile projects, including wrong-email, expiry, replay, and concurrent redemption cases.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: add secure account claims"
```

### Task 6: Implement teammate invitations and seat management

**Files:**
- Create: `packages/contracts/src/commerce/seats.ts`
- Create: `packages/domain/src/identity/seats.ts`
- Create: `packages/domain/src/identity/seats.test.ts`
- Create: `packages/database/src/repositories/{invitations,seats}.ts`
- Create: `apps/api/src/modules/seats/{invite,resend,revoke,redeem,transfer-owner}.ts`
- Create: `apps/api/src/routes/member/seats.ts`
- Create: `apps/api/src/modules/seats/seats.integration.test.ts`
- Modify: `apps/web/src/app/learn/settings/page.tsx`

**Interfaces:**
- Produces owner-only invite/resend/revoke/replace/ownership-transfer commands.
- Pending invite reserves a seat and expires after seven days; no account can exceed three pending/active seats under concurrency.
- Ownership transfer and seat replacement consume recent auth no older than five minutes and append reasoned audit events.

- [ ] **Step 1: Write seat-state and race tests**

Cover invite into last seat, fourth invite denial, expired invite release, revoke/reinvite, replay, wrong account, teammate owner action denial, and concurrent attempts.

```ts
it("never reserves a fourth seat", async () => {
  await seedOwnerAndInvite(accountId, "a@example.com");
  await seedInvite(accountId, "b@example.com");
  await expect(inviteSeat(command({ accountId, email: "c@example.com" }), deps))
    .rejects.toMatchObject({ code: "SEAT_LIMIT_REACHED" });
});

it("releases an expired pending reservation", () => {
  expect(expireInvitation(invitation({ expiresAt: minute(-1) }), now).seatState).toBe("expired");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/identity/seats.test.ts && npm run test:integration -w @syntholo/api -- seats.integration.test.ts`

Expected: FAIL because seat transition commands and database capacity enforcement do not exist.

- [ ] **Step 3: Implement domain transitions and transactional commands**

Use a partial unique/indexed capacity constraint plus transaction-level account lock; never infer seat count from Clerk users.

```ts
export async function inviteSeat(command: InviteSeat, deps: SeatDeps) {
  requireOwner(command.actor);
  return deps.uow.transaction(async (tx) => {
    await tx.accounts.lock(command.actor.accountId);
    const reserved = await tx.seats.countReserved(command.actor.accountId);
    if (reserved >= 3) throw new AppError("SEAT_LIMIT_REACHED", 409, "All seats are reserved");
    const token = deps.tokens.create();
    const invitation = await tx.invitations.insertPending(command.actor.accountId, command.email, sha256(token), addDays(deps.clock.now(), 7));
    await tx.outbox.enqueue(seatInvitedEvent(invitation));
    return { invitation, token };
  });
}
```

- [ ] **Step 4: Enqueue invitation email and expiry sweep jobs**

Email contains a hashed-token redemption link and transactional-only delivery. The daily expiry job marks pending reservations expired and records an audit event.

- [ ] **Step 5: Wire settings UI and run GREEN**

Show all three positions, invite expiry, resend/revoke actions, and recent-auth prompt; verify 44px controls and no cross-account data.

```tsx
export function SeatList({ seats, onInvite, onRevoke }: SeatListProps) {
  return <ol>{Array.from({ length: 3 }, (_, index) => {
    const seat = seats[index];
    return <li key={seat?.id ?? `empty-${index}`}>{seat ? <ReservedSeat seat={seat} onRevoke={onRevoke} /> : <InviteSeat onInvite={onInvite} />}</li>;
  })}</ol>;
}
```

Run: `npm test -w @syntholo/web -- seats && npm run test:integration -w @syntholo/api -- seats.integration.test.ts`

Expected: PASS; computed controls meet 44px target coverage and a fourth reservation never commits.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: manage Academy account seats"
```

### Task 7: Implement Pilot review, cohorts, capacity, and private checkout delivery

**Files:**
- Create: `packages/domain/src/applications/cohorts.ts`
- Create: `packages/domain/src/applications/cohorts.test.ts`
- Create: `packages/database/src/repositories/{applications,cohorts}.ts`
- Create: `apps/api/src/modules/applications/{review,assign-cohort,send-checkout}.ts`
- Create: `apps/api/src/routes/staff/{applications,cohorts}.ts`
- Create: `apps/api/src/modules/applications/pilot.integration.test.ts`
- Create: `apps/worker/src/handlers/commerce/send-pilot-checkout.ts`
- Create: `apps/web/src/app/admin/{applications,cohorts}/page.tsx`

**Interfaces:**
- Admin-only decisions: `request_information | approve | decline`; every decision requires reason and recent auth.
- Approval requires cohort ID and capacity; checkout authorization expires after 72 hours and is single-use.
- Produces `applications.pilot_checkout_authorized.v1` and a worker email containing cohort terms plus refund-policy version.

- [ ] **Step 1: Write transition/capacity RED tests**

Assert coach cannot review, admin cannot approve without capacity, two admins cannot take the last cohort slot, and declined applications cannot receive Checkout.

```ts
it("reserves the final cohort seat once", async () => {
  const results = await Promise.allSettled([
    approvePilot(command({ applicationId: "app_1", cohortId }), deps),
    approvePilot(command({ applicationId: "app_2", cohortId }), deps),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await cohorts.reservedCount(cohortId)).toBe(cohortCapacity);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/applications/cohorts.test.ts && npm run test:integration -w @syntholo/api -- pilot.integration.test.ts`

Expected: FAIL because cohort reservation and staff review commands do not exist.

- [ ] **Step 3: Implement audited staff commands and capacity locking**

Lock the cohort row before reserving capacity. Record reviewer, reason, old/new state, cohort, and timestamp.

```ts
export async function approvePilot(command: ApprovePilot, deps: PilotDeps) {
  requirePermission(command.actor, "applications:approve");
  requireRecentAuth(command.actor, 300);
  return deps.uow.transaction(async (tx) => {
    const cohort = await tx.cohorts.lock(command.cohortId);
    if (cohort.reserved >= cohort.capacity) throw new AppError("COHORT_FULL", 409, "Cohort is full");
    const application = await tx.applications.lock(command.applicationId);
    const approved = await tx.applications.approve(application, cohort.id, command.actor.staffId, command.reason);
    await tx.outbox.enqueue(pilotApprovedEvent(approved));
    return approved;
  });
}
```

- [ ] **Step 4: Implement worker delivery and admin UI**

The worker creates/reuses one authorization, renders the exact policy/cohort terms, and stores delivery state. The UI shows capacity and decision history without card data.

```ts
export async function sendPilotCheckout(job: PilotCheckoutJob, deps: PilotCheckoutDeps) {
  const authorization = await deps.authorizations.getOrCreate(job.applicationId, addHours(deps.clock.now(), 72));
  return deps.notifications.enqueue({
    eventId: job.eventId,
    recipientId: job.applicantId,
    template: "pilot_checkout",
    templateVersion: 1,
    data: { claimUrl: deps.urls.pilotCheckout(authorization.rawToken), cohortTerms: job.cohortTerms, refundPolicy: ACADEMY_REFUND_POLICY },
  });
}
```

- [ ] **Step 5: Run GREEN**

Run: `npm test -w @syntholo/domain -- applications && npm run test:integration -w @syntholo/api -- pilot.integration.test.ts && npm test -w @syntholo/worker -- pilot && npm run test:e2e -w @syntholo/web -- commerce-admin.spec.ts`

Expected: PASS with one winner for the final cohort capacity slot.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: operate Guided Pilot enrollment"
```

### Task 8: Implement Operator Club scheduled and immediate subscriptions

**Files:**
- Create: `packages/domain/src/commerce/operator-club.ts`
- Create: `packages/domain/src/commerce/operator-club.test.ts`
- Create: `apps/api/src/modules/commerce/operator-club/{quote,subscribe}.ts`
- Create: `apps/api/src/routes/member/operator-club.ts`
- Create: `apps/api/src/modules/commerce/operator-club.integration.test.ts`
- Modify: `apps/web/src/app/pricing/page.tsx`
- Modify: `apps/web/src/app/learn/settings/page.tsx`

**Interfaces:**
- Eligible only with a valid non-refunded Academy purchase.
- Selects the initial Club start as `max(exact included-support end, trusted fulfillment now)`: an early selection schedules Stripe for support expiry, while later re-entry starts immediately and is never backdated.
- Invoice success/failure/cancel events mutate only Club-derived `support`, `circle_write`, and `operator_club` grants.

- [ ] **Step 1: Write eligibility/start-date/grace RED tests**

Cover ineligible Business-OS-only account, early monthly/annual schedule, immediate start, invoice success, failed payment grace through day seven, and restriction on day eight.

```ts
it("schedules billing at included-support expiry", () => {
  expect(planOperatorClubStart({ now, supportEndsAt: day(40), academyAccess: true }))
    .toEqual({ mode: "schedule", startsAt: day(40) });
});

it("keeps Academy while Club grace expires", () => {
  const access = evaluateEntitlements(clubFixture({ clubStatus: "expired", academyStatus: "active" }));
  expect(access.capabilities.academy_course).toBe(true);
  expect(access.capabilities.operator_club).toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/commerce/operator-club.test.ts && npm run test:integration -w @syntholo/api -- operator-club.integration.test.ts`

Expected: FAIL because eligibility, scheduling, and subscription event handling do not exist.

- [ ] **Step 3: Implement server-calculated quote and Stripe schedule**

The browser chooses monthly/annual only. The API calculates eligibility and start time, persists subscription/schedule IDs, and emits state events.

```ts
export function planOperatorClubStart(input: { now: Date; supportEndsAt: Date | null; academyAccess: boolean }) {
  if (!input.academyAccess) throw new DomainError("ACADEMY_REQUIRED");
  return input.supportEndsAt && input.supportEndsAt > input.now
    ? { mode: "schedule" as const, startsAt: input.supportEndsAt }
    : { mode: "immediate" as const, startsAt: input.now };
}
```

- [ ] **Step 4: Extend webhook state handling**

Map invoice/subscription events by provider IDs; replay safely; preserve Academy lifetime access through every Club state.

- [ ] **Step 5: Run GREEN and entitlement regressions**

Run: `npm test -w @syntholo/domain -- operator-club entitlements && npm run test:integration -w @syntholo/api -- operator-club.integration.test.ts`

Expected: PASS; Club changes never remove lifetime Academy access.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: add Operator Club billing"
```

### Task 9: Implement refunds, cancellation, failures, and disputes

**Files:**
- Create: `packages/domain/src/commerce/{refund-policy,disputes}.ts`
- Create: `packages/domain/src/commerce/{refund-policy,disputes}.test.ts`
- Create: `packages/database/src/schema/commerce-cases.ts`
- Create: `packages/database/drizzle/0016_commerce_cases.sql`
- Create: `apps/api/src/modules/commerce/cases/{open,decide,apply-provider-result}.ts`
- Create: `apps/api/src/routes/{member,staff}/commerce-cases.ts`
- Create: `apps/api/src/modules/commerce/cases.integration.test.ts`
- Create: `apps/worker/src/handlers/commerce/send-access-impact.ts`
- Create: `apps/web/src/app/admin/commerce/page.tsx`

**Interfaces:**
- Produces case kinds `refund | cancellation | failed_invoice | dispute` and immutable decision/provider-action records.
- `approveAcademyRefund` requires purchase age ≤7 days or explicit legal override permission/reason.
- Open dispute adds `commerce`, `seat_changes`, and `business_os_activation` holds; it does not disable `academy_course`.
- Won dispute removes holds; lost dispute revokes only grants sourced from the disputed transaction.

- [ ] **Step 1: Write adversarial money-flow RED tests**

Cover duplicate refund webhook, concurrent admin/webhook resolution, day 7/day 8 policy boundary, legal override, open/won/lost dispute, subscription grace, and Business OS cancellation independence.

```ts
it.each([[7, true], [8, false]])("applies the Academy refund boundary at day %i", (ageDays, allowed) => {
  expect(evaluateAcademyRefundPolicy({ purchasedAt: day(-ageDays), requestedAt: day(0), legalOverride: false }).allowed)
    .toBe(allowed);
});

it("places narrow holds during an open dispute", () => {
  expect(holdsForDispute("open")).toEqual(["commerce", "seat_changes", "business_os_activation"]);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/commerce/refund-policy.test.ts src/commerce/disputes.test.ts && npm run test:integration -w @syntholo/api -- cases.integration.test.ts`

Expected: FAIL because commerce cases and source-linked reversal commands do not exist.

- [ ] **Step 3: Implement case state machines and Stripe actions**

Record request, policy version, actor, reason, provider action ID, old/new financial state, and idempotency key. Never call Stripe inside an open database transaction; persist intent, call provider idempotently, then apply signed/verified result.

```ts
export async function executeRefund(command: ExecuteRefund, deps: CommerceCaseDeps) {
  const intent = await deps.uow.transaction((tx) => tx.cases.createRefundIntent(command));
  const provider = await deps.stripe.refund({
    paymentIntentId: intent.paymentIntentId,
    amount: intent.amount,
    idempotencyKey: intent.id,
  });
  return deps.uow.transaction((tx) => applyRefundResult(tx, intent.id, provider, command.actor));
}
```

- [ ] **Step 4: Recompute source-linked grants and enqueue exact notice**

The notice enumerates access that changes and explicitly states that progress and earned certificates remain. Store rendered template version and delivery result.

- [ ] **Step 5: Prove history preservation**

Seed progress and a certificate, apply a full refund and lost dispute, then assert both rows/files remain and financial/audit histories are append-only.

- [ ] **Step 6: Run GREEN**

Run: `npm test -w @syntholo/domain -- commerce entitlements && npm run test:integration -w @syntholo/api -- cases.integration.test.ts && npm test -w @syntholo/worker -- commerce`

Expected: PASS, including duplicate provider events and achievement-history preservation.

- [ ] **Step 7: Commit**

```bash
git add apps packages
git commit -m "feat: handle refunds and payment disputes"
```

### Task 10: Complete commerce browser journeys and gate evidence

**Files:**
- Create: `apps/web/tests/e2e/commerce.spec.ts`
- Create: `apps/web/tests/e2e/commerce-admin.spec.ts`
- Create: `infra/scripts/gate-commerce.mjs`
- Create: `docs/operations/commerce.md`
- Modify: `package.json`

**Interfaces:**
- Produces `npm run gate:commerce` with machine-readable results for flows 1, 2, 5 subscription, and 6.
- Produces operator replay procedures that require event ID, reason, recent auth, and dry-run impact.

- [ ] **Step 1: Add failing E2E journeys**

Test public Self-Paced purchase simulation → claim → owner seat → invites; Pilot application → admin approval → cohort → private Checkout; Operator Club scheduled start; refund and dispute access impact.

```ts
test("Self-Paced purchase claims the owner inside three-seat capacity", async ({ page, stripeFixture }) => {
  await page.goto("/checkout/self-paced");
  await page.getByRole("button", { name: /continue to checkout/i }).click();
  await stripeFixture.completeCheckout({ offer: "self_paced" });
  await page.goto(stripeFixture.claimUrl);
  await clerkFixture.signIn(page, "owner@example.com");
  await expect(page.getByText("1 of 3 seats active")).toBeVisible();
});
```

- [ ] **Step 2: Run RED against a local Stripe fake**

Run: `npm run test:e2e -w @syntholo/web -- commerce.spec.ts commerce-admin.spec.ts`

Expected: at least the new journeys fail until all UI/API connections are complete.

- [ ] **Step 3: Finish UI error/loading/retry states and fixture hooks**

Fixtures may sign test provider events only in `NODE_ENV=test`; production refuses the fixture secret and endpoint.

```ts
if (process.env.NODE_ENV === "test") {
  app.post("/__test/stripe/events", async (request) => deps.testStripeEvents.deliver(request.body));
}

export function CommerceError({ code, correlationId }: { code: string; correlationId: string }) {
  return <Alert role="alert">{commerceErrorMessage(code)} Reference: {correlationId}</Alert>;
}
```

- [ ] **Step 4: Run full commerce verification**

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e -w @syntholo/web -- commerce.spec.ts commerce-admin.spec.ts
npm run gate:commerce
git diff --check
```

Expected: all pass; replay counts remain one; history-preservation check is green.

- [ ] **Step 5: Self-review**

Confirm Checkout cannot bypass offer/content gates, the browser never submits amounts/provider price IDs, Business OS creates no Academy grant, and refund/dispute never deletes achievements.

- [ ] **Step 6: Commit**

```bash
git add apps packages infra docs/operations package.json
git commit -m "test: verify production commerce flows"
```
