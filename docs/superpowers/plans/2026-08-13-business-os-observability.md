# Business OS and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operate Business OS as a fully isolated external HighLevel service with seven-check activation and monthly manual verification, while adding durable notifications, privacy-safe product analytics, error/health monitoring, and job/incident visibility across Syntholo.

**Architecture:** Syntholo stores only Business OS commercial/onboarding/provisioning state, non-customer-data evidence references, incidents, and the external login hyperlink. HighLevel has separate authentication and no Syntholo API integration. Cross-domain events feed durable Resend, PostHog, Sentry, health, and operations projections through adapters that enforce payload allowlists.

**Tech Stack:** Fastify, Zod, Drizzle/PostgreSQL, Stripe state from commerce, Resend, PostHog U.S. Cloud, Sentry, Next.js App Router, Railway cron/worker, Vitest, integration tests, and Playwright.

## Global Constraints

- This plan starts after foundation; checkout state consumes commerce interfaces.
- No source file, environment schema, deployment secret, or worker handler may contain a HighLevel API credential or customer-data synchronization adapter.
- Business OS has separate authentication. Syntholo only links to an approved external login URL; no SSO or shared session.
- Business OS never creates, revokes, pauses, or checks Academy course/support/Circle/Operator Club grants.
- Activation requires all seven named checks with status, evidence reference, actor, and timestamp.
- Evidence references must not mirror contacts, messages, appointments, pipelines, conversation content, or private customer data.
- V1 re-verifies all seven checks monthly and after material HighLevel changes or customer-reported incidents.
- Failed verification sets `degraded`, opens an incident, and notifies the customer without changing Academy.
- Automated synthetic monitoring is revisited at the first approved trigger: 25 active accounts, two customer-discovered degradations in 90 days, or >8 operator hours/month.
- Notifications are durable and transactional. PostHog and Sentry never receive customer names, private file names, support/artifact content, transcripts, contact lists, or message bodies.
- Session replay is disabled; analytics retention is 13 months; audit retention is at least 24 months.

## Planned File Map

- `packages/contracts/src/{business-os,notifications,analytics,operations}/**` — state and event schemas.
- `packages/domain/src/business-os/**` — onboarding, seven-check activation, verification, trigger rules.
- `packages/domain/src/operations/**` — incident and health rules.
- `packages/database/src/schema/{business-os,notifications,analytics,incidents}.ts` — durable projections.
- `packages/database/src/repositories/{business-os,notifications,analytics,incidents}.ts` — persistence.
- `packages/integrations/src/{resend,posthog,sentry}/**` — payload-filtering adapters.
- `apps/api/src/modules/{business-os,operations}/**` — use cases.
- `apps/worker/src/handlers/{business-os,notifications,analytics}/**` — scheduled work.
- `apps/web/src/app/learn/business-os/**` — member state and external handoff.
- `apps/web/src/app/admin/{provisioning,operations}/**` — staff operation screens.

---

### Task 1: Model Business OS onboarding, provisioning, and independent state

**Files:**
- Create: `packages/contracts/src/business-os/state.ts`
- Create: `packages/domain/src/business-os/state.ts`
- Create: `packages/domain/src/business-os/state.test.ts`
- Create: `packages/database/src/schema/business-os.ts`
- Create: `packages/database/drizzle/0024_business_os.sql`
- Create: `packages/database/src/repositories/business-os.ts`
- Create: `apps/api/src/modules/business-os/{get-onboarding,update-onboarding}.ts`
- Create: `apps/api/src/routes/{member,staff}/business-os.ts`
- Create: `apps/api/src/modules/business-os/business-os.integration.test.ts`

**Interfaces:**
- Produces states `not_purchased | onboarding | provisioning | ready_for_verification | active | degraded | suspended | canceled`.
- Produces onboarding fields limited to Syntholo operational needs and approved questionnaire schema; no HighLevel contact/message/pipeline records.
- Consumes effective `business_os` capability only; does not consume Academy capabilities.

- [ ] **Step 1: Write independence/lifecycle RED tests**

Cover purchase → onboarding → provisioning, cancel, Academy refund with active Business OS, Business OS degradation with active Academy, invalid activation skip, and member/staff authorization.

```ts
it("keeps Business OS and Academy independent", () => {
  const businessOs = transitionBusinessOs(businessOsState("active"), { type: "verification_failed" });
  const access = evaluateEntitlements(academyFixture({ academy: "active", businessOs: "active" }));
  expect(businessOs.status).toBe("degraded");
  expect(access.capabilities.academy_course).toBe(true);
});

it("cannot skip from onboarding to active", () => {
  expect(() => transitionBusinessOs(businessOsState("onboarding"), { type: "activate" })).toThrow("INVALID_BUSINESS_OS_TRANSITION");
});
```

- [ ] **Step 2: Run RED**

Run `npm test -w @syntholo/domain -- src/business-os`.

Expected: FAIL because Business OS state transitions and persistence do not exist.

- [ ] **Step 3: Implement state rules and scoped persistence**

Every transition records actor/reason and emits a domain event. No transition touches Academy grants. Store external login URL as environment-approved origin plus account-specific opaque path; reject arbitrary schemes/hosts.

```ts
export function transitionBusinessOs(state: BusinessOsState, action: BusinessOsAction): BusinessOsState {
  const next = BUSINESS_OS_TRANSITIONS[state.status]?.[action.type];
  if (!next) throw new DomainError("INVALID_BUSINESS_OS_TRANSITION");
  return { ...state, status: next, updatedAt: action.at };
}

export function externalLoginUrl(origin: URL, opaquePath: string, allowedOrigin: string): URL {
  if (origin.origin !== allowedOrigin || origin.protocol !== "https:") throw new DomainError("EXTERNAL_LOGIN_ORIGIN_DENIED");
  return new URL(opaquePath, origin);
}
```

- [ ] **Step 4: Run GREEN**

```bash
npm test -w @syntholo/domain -- business-os
npm run test:integration -w @syntholo/api -- business-os
```

Expected: PASS with Business OS/Academy independence and valid lifecycle enforcement.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages
git commit -m "feat: model isolated Business OS state"
```

### Task 2: Implement the seven-check activation workflow

**Files:**
- Create: `packages/domain/src/business-os/checks.ts`
- Create: `packages/domain/src/business-os/checks.test.ts`
- Create: `packages/contracts/src/business-os/checks.ts`
- Create: `packages/database/src/schema/business-os-checks.ts`
- Create: `packages/database/drizzle/0025_business_os_checks.sql`
- Create: `apps/api/src/modules/business-os/{record-check,activate}.ts`
- Create: `apps/api/src/routes/staff/business-os-checks.ts`
- Create: `apps/api/src/modules/business-os/checks.integration.test.ts`

**Interfaces:**
- Check codes are exactly `lead_capture`, `lead_routing`, `calendar_booking`, `two_way_messaging`, `client_onboarding`, `ai_human_escalation`, and `dashboard_reporting`.
- Each result stores `pending | passed | failed`, evidence reference, staff actor, checked timestamp, and check-set version.
- `activateBusinessOs` succeeds only when the latest result for all seven codes is passed and account is `ready_for_verification`.

- [ ] **Step 1: Write seven-check RED matrix**

Test 0/7, 6/7, failed check, stale prior check-set, all 7, coach denial, admin without recent auth, and activation replay.

```ts
it.each([[0, false], [6, false], [7, true]])("requires all seven current checks", (passed, allowed) => {
  expect(evaluateActivation(checkSet({ passed, version: 1 }), 1).allowed).toBe(allowed);
});

it("rejects a stale seven-check version", () => {
  expect(evaluateActivation(checkSet({ passed: 7, version: 1 }), 2)).toEqual({ allowed: false, reason: "STALE_CHECK_SET" });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/business-os/checks.test.ts && npm run test:integration -w @syntholo/api -- checks.integration.test.ts`

Expected: FAIL because the named seven-check gate and atomic activation do not exist.

- [ ] **Step 3: Implement exact check set and atomic activation**

Validate evidence as an opaque internal ticket/document reference, not copied customer data. Lock the Business OS row, re-read all current checks, set active once, and emit `business_os.activated.v1`.

```ts
export const BUSINESS_OS_CHECK_CODES = [
  "lead_capture", "lead_routing", "calendar_booking", "two_way_messaging",
  "client_onboarding", "ai_human_escalation", "dashboard_reporting",
] as const;

export function evaluateActivation(checks: readonly BusinessOsCheck[], currentVersion: number) {
  if (checks.some((check) => check.checkSetVersion !== currentVersion)) return { allowed: false, reason: "STALE_CHECK_SET" as const };
  const passed = new Set(checks.filter((check) => check.status === "passed").map((check) => check.code));
  return passed.size === BUSINESS_OS_CHECK_CODES.length
    ? { allowed: true, reason: null }
    : { allowed: false, reason: "SEVEN_CHECKS_REQUIRED" as const };
}
```

- [ ] **Step 4: Run GREEN**

```bash
npm test -w @syntholo/domain -- src/business-os/checks.test.ts
npm run test:integration -w @syntholo/api -- checks.integration.test.ts
```

Expected: PASS with all seven current checks required and one activation event.

- [ ] **Step 5: Commit**

```bash
git add apps packages
git commit -m "feat: gate Business OS activation with seven checks"
```

### Task 3: Build member onboarding and staff provisioning interfaces

**Files:**
- Modify: `apps/web/src/app/learn/business-os/page.tsx`
- Modify: `apps/web/src/features/business-os/business-os-onboarding.tsx`
- Modify: `apps/web/src/app/admin/provisioning/page.tsx`
- Create: `apps/web/src/features/business-os/checklist.tsx`
- Create: `apps/web/src/features/business-os/checklist.test.tsx`
- Create: `apps/web/tests/e2e/business-os.spec.ts`

**Interfaces:**
- Member sees Syntholo onboarding, provisioning SLA/status, customer-safe incidents, and external login hyperlink only.
- Staff sees seven named checks, evidence references, history, activation control, verification due date, and audit actor.
- External handoff opens a separate origin/session and is labeled accordingly.

- [ ] **Step 1: Write component/browser RED tests**

Test onboarding save, 6/7 activation disabled, 7/7 enabled after recent auth, degraded notice, external-login labeling, Academy still accessible, and absence of mirrored HighLevel customer records.

```tsx
it("requires seven checks and labels the separate login", () => {
  render(<BusinessOsChecklist state={businessOsFixture({ passedChecks: 6 })} />);
  expect(screen.getByRole("button", { name: "Activate Business OS" })).toBeDisabled();
  expect(screen.getByRole("link", { name: /open separate Business OS login/i })).toHaveAttribute("rel", expect.stringContaining("noopener"));
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/web -- business-os && npm run test:e2e -w @syntholo/web -- business-os.spec.ts`

Expected: FAIL because member/admin Business OS screens still use demo state.

- [ ] **Step 3: Replace demo state with typed API data**

Keep the approved UI style and seven-check labels. Do not embed HighLevel or pass Syntholo tokens/query data to the external URL.

```tsx
export function ExternalBusinessOsLink({ url }: { url: string }) {
  return <a href={url} target="_blank" rel="noopener noreferrer">Open separate Business OS login</a>;
}

export interface BusinessOsApi {
  getMemberStatus(): Promise<MemberBusinessOsStatus>;
  saveOnboarding(input: BusinessOsOnboardingInput): Promise<MemberBusinessOsStatus>;
  recordCheck(input: BusinessOsCheckInput): Promise<BusinessOsCheck>;
  activate(input: { reason: string }): Promise<BusinessOsState>;
}
```

- [ ] **Step 4: Run GREEN desktop/mobile**

```bash
npm test -w @syntholo/web -- business-os
npm run test:e2e -w @syntholo/web -- business-os.spec.ts
```

Expected: PASS in desktop/mobile projects without embedded HighLevel or shared-token parameters.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add Business OS operations interfaces"
```

### Task 4: Add monthly/manual verification, degradation, incidents, and automation triggers

**Files:**
- Create: `packages/domain/src/business-os/verification.ts`
- Create: `packages/domain/src/business-os/verification.test.ts`
- Create: `packages/database/src/schema/business-os-verification.ts`
- Create: `packages/database/drizzle/0026_business_os_verification.sql`
- Create: `apps/api/src/modules/business-os/{start-verification,complete-verification,record-incident,resolve-incident}.ts`
- Create: `apps/worker/src/handlers/business-os/schedule-verifications.ts`
- Create: `apps/worker/src/handlers/business-os/schedule-verifications.integration.test.ts`
- Create: `apps/web/src/app/admin/provisioning/verification/page.tsx`
- Create: `docs/operations/business-os-verification.md`

**Interfaces:**
- Verification reasons `monthly | material_change | customer_report`; a run contains one result for each seven-check code.
- Active accounts become due one calendar month after activation/latest completed verification.
- Any failed check atomically sets `degraded`, opens/link incident, and emits customer-notification event; a fully passed rerun resolves incident and restores `active`.
- Trigger report returns active account count, early customer-discovered degradations in trailing 90 days, and staff verification minutes in current month.

- [ ] **Step 1: Write cadence/degradation/trigger RED tests**

Cover month boundary, duplicate cron, material-change immediate due, customer report, one failed check, rerun recovery, 25 accounts, two early degradations, and >480 operator minutes.

```ts
it("makes active Business OS due monthly", () => {
  expect(nextVerificationDue(new Date("2026-01-31T15:00:00Z"))).toEqual(new Date("2026-02-28T15:00:00Z"));
});

it.each([
  [{ activeAccounts: 25, earlyDegradations90d: 0, operatorMinutes: 0 }, true],
  [{ activeAccounts: 1, earlyDegradations90d: 2, operatorMinutes: 0 }, true],
  [{ activeAccounts: 1, earlyDegradations90d: 0, operatorMinutes: 481 }, true],
])("evaluates the monitoring automation trigger", (input, expected) => {
  expect(evaluateMonitoringTrigger(input).triggered).toBe(expected);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/business-os/verification.test.ts && npm run test:integration -w @syntholo/worker -- schedule-verifications.integration.test.ts`

Expected: FAIL because monthly verification, degradation, recovery, and trigger reporting do not exist.

- [ ] **Step 3: Implement schedule and verification state machine**

Cron only enqueues due-run creation; handler uses unique `(account_id, period_start, reason)` keys. Verification evidence remains metadata references. Academy entitlements are never loaded or changed by the command.

```ts
export async function completeVerification(command: CompleteVerification, deps: BusinessOsDeps) {
  return deps.uow.transaction(async (tx) => {
    const run = await tx.businessOs.lockVerification(command.runId);
    assertSevenResults(command.results);
    const failed = command.results.some((result) => result.status === "failed");
    await tx.businessOs.completeVerification(run.id, command.results, command.actor.staffId);
    const state = failed
      ? await tx.businessOs.degradeAndOpenIncident(run.accountId, command.actor)
      : await tx.businessOs.restoreAndResolveIncident(run.accountId, command.actor);
    await tx.outbox.enqueue(businessOsVerificationEvent(state, run));
    return state;
  });
}
```

- [ ] **Step 4: Document the manual v1 limitation and automate-trigger report**

The runbook assigns owner, monthly queue, material-change/customer-report handling, degraded customer notice, recovery, and the exact threshold review process.

- [ ] **Step 5: Run GREEN**

```bash
npm test -w @syntholo/domain -- src/business-os/verification.test.ts
npm run test:integration -w @syntholo/worker -- schedule-verifications.integration.test.ts
```

Expected: PASS for monthly/material/customer-report cadence, degradation/recovery, and all three automation triggers.

- [ ] **Step 6: Commit**

```bash
git add apps packages docs/operations
git commit -m "feat: reverify Business OS operating state"
```

### Task 5: Prove HighLevel isolation in code and deployment configuration

**Files:**
- Create: `infra/scripts/check-highlevel-isolation.mjs`
- Create: `infra/scripts/check-highlevel-isolation.test.ts`
- Create: `docs/architecture/highlevel-isolation.md`
- Modify: `infra/scripts/gate-foundation.mjs`

**Interfaces:**
- Produces `npm run check:highlevel-isolation`, which fails on HighLevel SDK imports, API base URLs, API-key env names, SSO/session exchange, or background customer-data adapters.
- Allows only UI copy, `business_os` domain naming, approved external login origin, and docs describing isolation.

- [ ] **Step 1: Write the failing static-boundary test**

Create a synthetic fixture containing `HIGHLEVEL_API_KEY` and `fetch("https://rest.gohighlevel.com")`; assert the checker reports both. The focused test is RED because the checker does not exist; the repository itself must already be clean from the foundation gate.

```ts
it("finds HighLevel secrets and API calls", async () => {
  const result = await checkHighLevelIsolation(fixtureTree({
    "src/bad.ts": 'const key = process.env.HIGHLEVEL_API_KEY; fetch("https://rest.gohighlevel.com/v1/contacts")',
  }));
  expect(result.violations.map((violation) => violation.rule)).toEqual(["API_CREDENTIAL", "API_CONNECTION"]);
});
```

- [ ] **Step 2: Remove the obsolete adapter and env contract**

Delete any HighLevel API functions/secrets. Replace them with the Business OS state API and a validated external login origin.

```ts
export const BusinessOsExternalConfigSchema = z.object({
  BUSINESS_OS_LOGIN_ORIGIN: z.string().url().refine((value) => new URL(value).protocol === "https:"),
});

// Deliberately no HighLevel API key, client, webhook, or customer-data method.
export type BusinessOsExternalConfig = z.infer<typeof BusinessOsExternalConfigSchema>;
```

- [ ] **Step 3: Run isolation check**

```bash
npm run check:highlevel-isolation
rg -n "HIGHLEVEL_.*KEY|gohighlevel\.com|leadconnectorhq\.com.*api|highlevel.*(client|sdk)" apps packages infra
```

Expected: checker passes; `rg` returns only test fixtures/documented forbidden examples or no result.

- [ ] **Step 4: Commit**

```bash
git add apps packages infra docs/architecture
git commit -m "refactor: enforce HighLevel isolation"
```

### Task 6: Create the durable transactional notification system

**Files:**
- Create: `packages/contracts/src/notifications/events.ts`
- Create: `packages/database/src/schema/notifications.ts`
- Create: `packages/database/drizzle/0027_notifications.sql`
- Create: `packages/database/src/repositories/notifications.ts`
- Create: `packages/integrations/src/resend/{port,adapter}.ts`
- Create: `apps/worker/src/handlers/notifications/{render,send}.ts`
- Create: `apps/worker/src/handlers/notifications/send.integration.test.ts`
- Create: `apps/api/src/routes/staff/notifications.ts`
- Modify: `packages/integrations/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Notification key is `(event_id, recipient_id, template_version, channel)`; retries never duplicate a successful delivery.
- Template registry covers account claim, seat invite, Pilot checkout, receipt, access impact, support warning/reply, session reminders, certificate, Circle sync failure, Business OS activation/degradation/recovery, and security events.
- Transactional delivery ignores marketing consent; marketing messages are outside this system.

- [ ] **Step 1: Write render/idempotency/redaction RED tests**

Cover missing template data, retry after Resend timeout, provider success then worker crash, duplicate event, suppressed staging recipient, and absence of private content in metadata.

```ts
it("delivers one logical notification across retries", async () => {
  resend.send.mockResolvedValue({ id: "email_1" });
  await expect(sendNotification(job, depsWithCrashAfterProvider())).rejects.toThrow("simulated crash");
  await sendNotification(job, deps);
  expect(await notifications.countLogical(job.eventId, job.recipientId, job.templateVersion)).toBe(1);
  expect(await notifications.get(job.id)).toMatchObject({ status: "delivered", providerMessageId: "email_1" });
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test:integration -w @syntholo/worker -- send.integration.test.ts`

Expected: FAIL because versioned notification delivery receipts do not exist.

- [ ] **Step 3: Implement versioned templates and delivery receipts**

Render server-side from allowlisted fields; store template version, provider message ID, attempts, and safe error. Staging redirects to approved test inboxes and prefixes subject.

```bash
npm install resend -w @syntholo/integrations
```

```ts
export async function sendNotification(job: NotificationJob, deps: NotificationDeps) {
  const delivery = await deps.notifications.claim(job.logicalKey);
  if (delivery.status === "delivered") return delivery;
  const rendered = deps.templates.render(job.template, job.templateVersion, job.data);
  const response = await deps.resend.send({ to: deps.recipients.resolve(job.recipientId), ...rendered, idempotencyKey: job.logicalKey });
  return deps.notifications.markDelivered(delivery.id, response.id);
}
```

- [ ] **Step 4: Add admin delivery status/replay with recent auth**

Replay creates a new audited attempt on the same logical delivery, not a duplicate notification record.

```ts
export async function replayNotification(command: ReplayNotification, deps: NotificationDeps) {
  requirePermission(command.actor, "notifications:replay");
  requireRecentAuth(command.actor, 300);
  return deps.uow.transaction(async (tx) => {
    const delivery = await tx.notifications.get(command.deliveryId);
    await tx.audit.append(notificationReplayAudit(delivery, command.actor, command.reason));
    return tx.jobs.enqueueOnce(`notification-replay:${delivery.id}:${delivery.attempts + 1}`, { deliveryId: delivery.id });
  });
}
```

- [ ] **Step 5: Run GREEN**

```bash
npm run test:integration -w @syntholo/worker -- send.integration.test.ts
npm run test:integration -w @syntholo/api -- notifications
```

Expected: PASS with one logical delivery, durable retries, staging recipient controls, and audited replay.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: deliver transactional notifications"
```

### Task 7: Add a privacy-safe PostHog event registry and consent boundary

**Files:**
- Create: `packages/contracts/src/analytics/events.ts`
- Create: `packages/domain/src/analytics/policy.ts`
- Create: `packages/domain/src/analytics/policy.test.ts`
- Create: `packages/database/src/schema/analytics.ts`
- Create: `packages/database/drizzle/0028_analytics.sql`
- Create: `packages/integrations/src/posthog/{server,client-policy}.ts`
- Create: `apps/worker/src/handlers/analytics/deliver.ts`
- Create: `apps/worker/src/handlers/analytics/deliver.test.ts`
- Modify: `apps/web/src/lib/integrations/posthog.ts`
- Create: `docs/architecture/analytics-data-policy.md`
- Modify: `packages/integrations/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces an explicit event union for the approved funnel/quality events; each event has an allowlisted property schema.
- Uses pseudonymous internal IDs; no name/email/content/file name/transcript/message body/contact list.
- Client analytics requires consent state where legally required; server transactional product events use documented legitimate operational basis. Session replay remains disabled.

- [ ] **Step 1: Write payload-policy RED tests**

Pass valid checkout/lesson/SLA events; reject extra `email`, `businessName`, `message`, `transcript`, `fileName`, or nested unknown values.

```ts
it.each(["email", "businessName", "message", "transcript", "fileName"])('rejects analytics property "%s"', (key) => {
  const result = AnalyticsEventSchema.safeParse({
    name: "lesson_completed",
    distinctId: "member_opaque",
    properties: { lessonId: "lesson_1", [key]: "secret" },
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/analytics/policy.test.ts && npm test -w @syntholo/worker -- analytics/deliver.test.ts`

Expected: FAIL because the analytics event allowlist and worker delivery do not exist.

- [ ] **Step 3: Implement registry, runtime validation, and delivery**

All producers enqueue validated analytics events; worker validates again before PostHog. Invalid payload becomes operations-visible dead letter and is never forwarded.

```bash
npm install posthog-node -w @syntholo/integrations
```

```ts
export const AnalyticsEventSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("lesson_completed"), distinctId: OpaqueIdSchema, properties: z.object({ lessonId: OpaqueIdSchema }).strict() }),
  z.object({ name: z.literal("checkout_completed"), distinctId: OpaqueIdSchema, properties: z.object({ offerCode: OfferCodeSchema, campaign: z.string().max(160).optional() }).strict() }),
  z.object({ name: z.literal("support_sla_satisfied"), distinctId: OpaqueIdSchema, properties: z.object({ businessMinutes: z.number().int().nonnegative() }).strict() }),
]);

export const ANALYTICS_EVENT_NAMES = [
  "landing_viewed", "scorecard_started", "scorecard_completed", "report_unlocked",
  "pilot_application_submitted", "pilot_application_approved", "pilot_application_declined",
  "checkout_started", "checkout_completed", "account_claimed", "teammate_invited", "teammate_activated",
  "onboarding_completed", "first_lesson_started", "lesson_completed", "course_completed", "certificate_issued",
  "support_thread_opened", "substantive_coach_reply", "session_rsvp", "session_attendance",
  "operator_club_scheduled", "operator_club_active", "business_os_onboarding", "business_os_activation",
  "business_os_degradation", "refund", "dispute", "cancellation",
] as const;

export async function deliverAnalytics(event: unknown, deps: AnalyticsDeps) {
  const validated = AnalyticsEventSchema.parse(event);
  await deps.posthog.capture(validated);
}
```

- [ ] **Step 4: Configure client consent and retention documentation**

Disable replay/autocapture unless separately reviewed, separate staging/project keys, and document 13-month deletion settings.

- [ ] **Step 5: Run GREEN**

```bash
npm test -w @syntholo/domain -- src/analytics/policy.test.ts
npm test -w @syntholo/worker -- analytics/deliver.test.ts
```

Expected: PASS; every forbidden property is rejected before PostHog delivery.

- [ ] **Step 6: Commit**

```bash
git add apps packages docs/architecture
git commit -m "feat: enforce privacy-safe product analytics"
```

### Task 8: Integrate Sentry, dependency health, job operations, and incident status

**Files:**
- Create: `packages/integrations/src/sentry/scrubber.ts`
- Create: `packages/integrations/src/sentry/scrubber.test.ts`
- Create: `packages/contracts/src/operations/health.ts`
- Create: `apps/api/src/modules/operations/{health,list-jobs,replay-job}.ts`
- Create: `apps/api/src/routes/staff/operations.ts`
- Create: `apps/worker/src/operations/report-heartbeat.ts`
- Create: `apps/web/src/app/admin/operations/page.tsx`
- Create: `docs/operations/monitoring.md`
- Modify: `apps/api/package.json`
- Modify: `apps/worker/package.json`
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Scrubber removes request authorization/cookies, names/emails, content keys, file names, transcript/support/artifact payloads, provider bodies, and database parameters.
- Readiness health returns configured dependency state/latency only; liveness never depends on vendors.
- Staff operations lists jobs/dead letters/incidents with customer impact, attempts, next action, release SHA, and audited replay requiring recent auth/reason.

- [ ] **Step 1: Write scrubber/health/replay RED tests**

Test nested sensitive fields, headers, provider errors, database outage degraded status, vendor outage isolation, unauthorized coach/admin operations, stale recent auth, and idempotent job replay.

```ts
it("scrubs restricted data recursively", () => {
  const scrubbed = scrubSentryEvent({
    request: { headers: { authorization: "Bearer secret", cookie: "session=secret" } },
    extra: { email: "person@example.com", transcript: "private", correlationId: "safe" },
  });
  expect(JSON.stringify(scrubbed)).not.toMatch(/secret|person@example|private/);
  expect(scrubbed.extra.correlationId).toBe("safe");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/integrations -- sentry && npm run test:integration -w @syntholo/api -- operations`

Expected: FAIL because scrubbing, dependency health, and operations replay controls do not exist.

- [ ] **Step 3: Implement Sentry releases/scrubbing and health checks**

Use one release SHA across services. Health checks have strict timeouts and do not leak URLs/account IDs/keys. API reports database outage as read-only/degraded; it never swaps to demo data.

```bash
npm install @sentry/node -w @syntholo/api -w @syntholo/worker
npm install @sentry/nextjs -w @syntholo/web
```

```ts
export function scrubSentryEvent(event: SentryEvent): SentryEvent {
  return redactKeys(event, new Set([
    "authorization", "cookie", "email", "name", "fileName", "messageBody",
    "transcript", "artifact", "supportContent", "providerPayload", "queryParameters",
  ]));
}

export async function readinessHealth(deps: HealthDeps): Promise<HealthResponse> {
  const database = await timedHealthCheck("database", 750, deps.database.ping);
  return { status: database.status === "ok" ? "ok" : "degraded", service: deps.service, releaseSha: deps.releaseSha, dependencies: [database] };
}
```

- [ ] **Step 4: Implement operations UI and monitor runbook**

Include API uptime, worker/cron heartbeat, dead-letter count, Stripe webhook lag, notification backlog, Circle sync failures, certificate backlog, and Business OS overdue checks.

```tsx
export const OPERATION_METRICS: readonly OperationMetricKey[] = [
  "api_uptime", "worker_heartbeat", "cron_heartbeat", "dead_letter_count", "stripe_webhook_lag",
  "notification_backlog", "circle_sync_failures", "certificate_backlog", "business_os_overdue_checks",
];

export function OperationsGrid({ health }: { health: OperationsHealth }) {
  return <div className="operations-grid">{OPERATION_METRICS.map((key) => <OperationMetric key={key} metric={health[key]} />)}</div>;
}
```

- [ ] **Step 5: Run GREEN**

```bash
npm test -w @syntholo/integrations -- sentry
npm run test:integration -w @syntholo/api -- operations
```

Expected: PASS with recursive redaction, degraded dependency state, and recent-auth replay control.

- [ ] **Step 6: Commit**

```bash
git add apps packages docs/operations
git commit -m "feat: add production observability controls"
```

### Task 9: Complete Business OS and observability gate evidence

**Files:**
- Create: `apps/web/tests/e2e/operations-observability.spec.ts`
- Create: `infra/scripts/gate-business-os.mjs`
- Create: `docs/operations/business-os.md`
- Modify: `package.json`

**Interfaces:**
- Produces `npm run gate:business-os`, including seven checks, degradation/recovery, trigger report, HighLevel isolation, notification idempotency, analytics allowlist, Sentry scrubber, and health/dead-letter controls.

- [ ] **Step 1: Add failing E2E/operations journeys**

Business OS purchase state → onboarding → 7 checks → activate → monthly failure → degraded incident/notice → pass/recover; validate Academy throughout; inject provider failures and inspect operations state.

```ts
test("Business OS degradation does not affect Academy", async ({ page, operationsFixture }) => {
  await adminFixture.passBusinessOsChecks(page, accountId, 7);
  await adminFixture.activateBusinessOs(page, accountId);
  await operationsFixture.failMonthlyCheck(accountId, "ai_human_escalation");
  await memberFixture.signIn(page, accountId);
  await expect(page.getByText("Business OS needs attention")).toBeVisible();
  await page.goto("/learn/course");
  await expect(page.getByRole("heading", { name: "Your course" })).toBeVisible();
});
```

- [ ] **Step 2: Run RED and close integration gaps**

Run: `npm run test:e2e -w @syntholo/web -- business-os.spec.ts operations-observability.spec.ts`

Expected: FAIL until the Business OS and operations screens consume production state.

Wire the final operations boundary through these exact clients:

```ts
export interface OperationsApi {
  getBusinessOsVerificationQueue(): Promise<readonly VerificationQueueItem[]>;
  getDeadLetters(): Promise<readonly DeadLetterSummary[]>;
  replayJob(jobId: string, reason: string): Promise<JobSummary>;
  getReleaseHealth(): Promise<ReleaseHealth>;
}
```

- [ ] **Step 3: Run full verification**

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e -w @syntholo/web -- business-os.spec.ts operations-observability.spec.ts
npm run check:highlevel-isolation
npm run gate:business-os
git diff --check
```

Expected: all pass; HighLevel isolation is green; Academy access remains unchanged across every Business OS transition.

- [ ] **Step 4: Self-review**

Confirm all seven checks are named, monthly/manual limitation and triggers are visible, no HighLevel integration exists, notifications are durable, and observability payloads contain no restricted data.

- [ ] **Step 5: Commit**

```bash
git add apps packages infra docs/operations package.json
git commit -m "test: verify Business OS and observability"
```
