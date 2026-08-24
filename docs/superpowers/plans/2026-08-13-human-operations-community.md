# Human Operations and Community Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make account-shared support, coach assignment/SLA, one-at-a-time artifact review, safe attachments, cohort/office-hour sessions, reminders, and entitlement-driven Circle access fully operational.

**Architecture:** Support threads and review queues belong to accounts, while messages retain their individual actor. PostgreSQL state machines own assignment, SLA, review locks, sessions, and Circle sync intent. The worker handles scans, reminders, email/calendar delivery, and Circle Admin API retries; Circle remains the community content system of record and Zoom links remain manually entered in v1.

**Tech Stack:** Fastify, Zod, Drizzle/PostgreSQL, `@js-temporal/polyfill`, Cloudflare Access staff auth, Clerk member auth, Vercel Blob, ClamAV, Resend, Circle OAuth/Admin API, Next.js App Router, Vitest, PostgreSQL integration tests, and Playwright.

## Global Constraints

- This plan starts after foundation; review work also requires artifact versioning from the content/learning plan, and Pilot sessions require cohort records from commerce.
- Support threads belong to `accountId`, not a member. Every active owner/teammate sees the same history.
- The first customer message starts the two-U.S.-business-day substantive-response SLA and assigns a coach round-robin.
- The SLA warns in the final eight business hours, pauses only in `waiting_on_customer`, resumes on customer reply, and records breach/satisfaction as events.
- Coaches cannot see card data, refunds, revenue analytics, staff management, or unrestricted exports.
- One account may have only one artifact review in `submitted | in_review`; PostgreSQL enforces the lock.
- A returned review points to the exact immutable artifact version and releases the account lock.
- Uploads remain quarantined until extension/MIME/size and ClamAV checks pass; maximum support attachment size is 25 MB.
- Pilot sessions are four weekly instances from cohort start. Office hours expose Americas and Europe/Asia recurring slots.
- V1 Zoom links are manually entered and protected; automate at the first approved trigger (three concurrent cohorts, two link/timezone incidents in 90 days, or >2 staff hours/month).
- Circle owns posts/comments/reactions/moderation content. Syntholo stores only identity/access synchronization state and does not mirror community content.

## Planned File Map

- `packages/contracts/src/{support,reviews,sessions,community}/**` — request/response/event schemas.
- `packages/domain/src/{support,reviews,sessions,community}/**` — clocks and state machines.
- `packages/database/src/schema/{support,reviews,sessions,community}.ts` — state.
- `packages/database/src/repositories/{support,reviews,sessions,community}.ts` — scoped access.
- `packages/integrations/src/{blob,clamav,resend,circle}/**` — ports/adapters.
- `apps/api/src/modules/{support,reviews,sessions,community}/**` — use cases.
- `apps/api/src/routes/{member,staff}/**` — member/coach/admin endpoints.
- `apps/worker/src/handlers/{files,support,sessions,community}/**` — durable side effects.
- `apps/web/src/app/learn/{support,live,community}/**` — member UI.
- `apps/web/src/app/coach/**`, `apps/web/src/app/admin/{sessions,community}/**` — operations UI.

---

### Task 1: Implement the U.S. business-time SLA calendar

**Files:**
- Create: `packages/domain/src/support/{business-calendar,sla}.ts`
- Create: `packages/domain/src/support/{business-calendar,sla}.test.ts`
- Create: `packages/contracts/src/support/sla.ts`
- Modify: `packages/domain/package.json`

**Interfaces:**
- Produces `BusinessCalendar = { timeZone: "America/New_York"; holidays: readonly LocalDate[]; workdayStartHour: 9; workdayEndHour: 17 }` loaded from versioned operations configuration.
- Produces `calculateSla(input): { dueAt; warningAt; remainingBusinessMinutes; state }` where target is 960 business minutes and warning begins at 480 remaining.
- Produces pause/resume calculations using recorded intervals, never by rewriting the original start.

- [ ] **Step 1: Write clock RED tests**

Cover Friday afternoon, weekend, U.S. holiday, daylight-saving boundary, waiting pause, customer resume, warning threshold, exact due time, and breach.

```ts
it.each([
  ["2026-08-14T20:00:00Z", "2026-08-18T20:00:00Z"],
  ["2026-11-25T20:00:00Z", "2026-11-30T20:00:00Z"],
])("adds two U.S. business days", (startedAt, dueAt) => {
  expect(calculateSla({ startedAt: new Date(startedAt), pauses: [], now: new Date(startedAt), calendar }).dueAt)
    .toEqual(new Date(dueAt));
});

it("pauses while waiting on the customer", () => {
  expect(calculateSla({ startedAt, pauses: [{ startedAt: hour(2), endedAt: hour(10) }], now: hour(12), calendar }).remainingBusinessMinutes)
    .toBe(840);
});
```

- [ ] **Step 2: Run RED**

Run `npm test -w @syntholo/domain -- src/support`.

Expected: current SLA helper does not implement the approved business calendar.

- [ ] **Step 3: Implement minute-accurate pure calculations**

Use explicit IANA timezone conversion and versioned holiday inputs. Avoid `Date.setHours` local-machine assumptions. Return deterministic timestamps for the same calendar version.

```ts
export function calculateSla(input: CalculateSlaInput): SlaProjection {
  const elapsed = businessMinutesBetween(input.startedAt, input.now, input.calendar)
    - input.pauses.reduce((sum, pause) => sum + businessMinutesBetween(pause.startedAt, pause.endedAt ?? input.now, input.calendar), 0);
  const remainingBusinessMinutes = Math.max(0, 960 - elapsed);
  return {
    dueAt: addBusinessMinutes(input.startedAt, 960 + pausedBusinessMinutes(input.pauses, input.calendar), input.calendar),
    warningAt: addBusinessMinutes(input.startedAt, 480 + pausedBusinessMinutes(input.pauses, input.calendar), input.calendar),
    remainingBusinessMinutes,
    state: remainingBusinessMinutes === 0 ? "breached" : remainingBusinessMinutes <= 480 ? "warning" : "active",
  };
}
```

Use `Temporal.ZonedDateTime` from `@js-temporal/polyfill` for all calendar math; convert to/from native `Date` only at repository/API boundaries.

```bash
npm install @js-temporal/polyfill -w @syntholo/domain
```

- [ ] **Step 4: Run GREEN**

```bash
npm test -w @syntholo/domain -- src/support
```

Expected: PASS across weekend, holiday, pause/resume, warning, and breach cases.

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/contracts
git commit -m "feat: calculate coach business-time SLA"
```

### Task 2: Persist account-shared support threads and messages

**Files:**
- Create: `packages/database/src/schema/support.ts`
- Create: `packages/database/drizzle/0017_support.sql`
- Create: `packages/database/src/repositories/support.ts`
- Create: `apps/api/src/modules/support/{open-thread,list-threads,get-thread,send-message}.ts`
- Create: `apps/api/src/routes/{member,staff}/support.ts`
- Create: `apps/api/src/modules/support/support.integration.test.ts`
- Create: `packages/contracts/src/support/threads.ts`

**Interfaces:**
- Produces thread states `open | waiting_on_customer | resolved | closed`; thread carries immutable `accountId`.
- Produces idempotent member `POST /v1/member/support/threads/:id/messages` and coach reply route.
- Message stores `actorKind`, internal actor ID, safe body, timestamps, and attachment references; bodies never enter audit/analytics.

- [ ] **Step 1: Write shared-history and isolation RED tests**

Owner opens; teammate reads/replies; other account denied; coach sees assigned account context; coach cannot query commerce; duplicate message command creates one row.

```ts
it("shares one thread within the account and denies another account", async () => {
  const thread = await openThread(command(owner), deps);
  await sendMessage(messageCommand(teammate, thread.id), deps);
  expect(await getThread(query(owner, thread.id), deps)).toMatchObject({ messages: expect.any(Array) });
  await expect(getThread(query(otherAccountMember, thread.id), deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("deduplicates a member message command", async () => {
  await Promise.all([sendMessage(message, deps), sendMessage(message, deps)]);
  expect(await support.countMessages(message.idempotencyKey)).toBe(1);
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test:integration -w @syntholo/api -- support.integration.test.ts`

Expected: FAIL because account-shared support repositories and routes do not exist.

- [ ] **Step 3: Implement scoped repositories and commands**

Sanitize/limit body, derive account from actor, append safe audit metadata, and emit `support.customer_message_added.v1` only for customer messages.

```ts
export async function sendMessage(command: SendSupportMessage, deps: SupportDeps) {
  const body = SupportMessageBodySchema.parse(command.body);
  return deps.uow.transaction(async (tx) => {
    const thread = await tx.support.getThread(command.actor.accountId, command.threadId);
    const message = await tx.support.insertMessageOnce(thread.id, command.actor, body, command.idempotencyKey);
    if (command.actor.kind === "member") await tx.outbox.enqueue(customerMessageAddedEvent(thread, message));
    await tx.audit.append(supportMessageAudit(thread, message, command.actor));
    return message;
  });
}
```

- [ ] **Step 4: Run GREEN under RLS roles**

Run: `npm run test:integration -w @syntholo/api -- support.integration.test.ts`

Expected: PASS with shared account history and cross-account denial under the runtime RLS role.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages
git commit -m "feat: persist account-shared support"
```

### Task 3: Add coach round-robin assignment and SLA events

**Files:**
- Create: `packages/domain/src/support/assignment.ts`
- Create: `packages/domain/src/support/assignment.test.ts`
- Create: `packages/database/src/schema/coach-operations.ts`
- Create: `packages/database/drizzle/0018_coach_operations.sql`
- Create: `packages/database/src/repositories/coach-queue.ts`
- Create: `apps/api/src/modules/support/{assign,transition,reassign}.ts`
- Create: `apps/api/src/modules/support/record-effort.ts`
- Create: `apps/worker/src/handlers/support/evaluate-sla.ts`
- Create: `apps/api/src/modules/support/coach-queue.integration.test.ts`

**Interfaces:**
- Coach availability is `active | away`; assignment orders by active state, current open workload, last-assigned timestamp, then stable staff ID.
- Produces SLA events `started | warned | paused | resumed | satisfied | breached` and one current projection derived from append-only events.
- Manual reassignment requires staff actor, reason, and audit event.
- A substantive response is a customer-visible coach message with `responseKind: "answer" | "review_feedback" | "action_request"` and non-empty validated body. Automated acknowledgments, internal notes, assignment changes, and status-only messages never satisfy the SLA.
- Produces `recordSupportEffort({ threadId, minutes, category, actor })`, where minutes is `1..480` and category is `reply | review | research | escalation | administration`; monthly aggregation by account supports the ≤20 minutes/active-business KPI without storing message content in analytics.

- [ ] **Step 1: Write assignment/state RED tests**

Cover no coaches, active vs away, workload balance, stable tie-break, concurrent first messages, final-eight-hour warning, waiting pause, substantive coach response satisfaction, and breach.

```ts
it("chooses the active coach with least work and stable tie break", () => {
  const chosen = chooseCoach([
    coach({ id: "b", workload: 1, status: "active" }),
    coach({ id: "a", workload: 1, status: "active" }),
    coach({ id: "z", workload: 0, status: "away" }),
  ]);
  expect(chosen?.id).toBe("a");
});

it("records substantive response satisfaction once", async () => {
  await replyAsCoach({ substantive: true });
  await replyAsCoach({ substantive: true });
  expect(await slaEvents.count("satisfied")).toBe(1);
});

it.each(["automated_ack", "internal_note", "status_only"])("does not satisfy SLA with %s", async (responseKind) => {
  await replyAsCoach({ responseKind });
  expect(await slaEvents.count("satisfied")).toBe(0);
});

it("aggregates explicit coach effort by account and month", async () => {
  await recordSupportEffort(effortCommand({ minutes: 12, category: "reply" }), deps);
  await recordSupportEffort(effortCommand({ minutes: 7, category: "review" }), deps);
  expect(await coachQueue.supportMinutes(accountId, "2026-08")).toBe(19);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/support/assignment.test.ts && npm run test:integration -w @syntholo/api -- coach-queue.integration.test.ts`

Expected: FAIL because transaction-safe assignment and SLA events do not exist.

- [ ] **Step 3: Implement transaction-safe assignment**

Lock eligible coach workload rows, select deterministically, record assignment and `started` event with the first customer message transaction, and expose explicit unassigned operations state if no coach is active.

```ts
export function chooseCoach(coaches: readonly CoachAvailability[]): CoachAvailability | null {
  return [...coaches].filter((coach) => coach.status === "active").sort((a, b) =>
    a.openWorkload - b.openWorkload ||
    a.lastAssignedAt.getTime() - b.lastAssignedAt.getTime() ||
    a.id.localeCompare(b.id),
  )[0] ?? null;
}
```

- [ ] **Step 4: Implement SLA evaluation job**

Cron enqueues evaluation every 15 minutes; handler inserts a warning/breach only once using unique `(thread_id, event_type, sla_cycle)`.

```ts
export async function evaluateSlaJob(job: EvaluateSlaJob, deps: SupportDeps) {
  const thread = await deps.support.getSlaThread(job.threadId);
  const projection = calculateSla({ ...thread.slaInput, now: deps.clock.now(), calendar: deps.calendar });
  if (projection.state === "warning") await deps.support.insertSlaEventOnce(thread.id, thread.slaCycle, "warned", deps.clock.now());
  if (projection.state === "breached") await deps.support.insertSlaEventOnce(thread.id, thread.slaCycle, "breached", deps.clock.now());
}
```

- [ ] **Step 5: Run GREEN**

```bash
npm test -w @syntholo/domain -- src/support/assignment.test.ts
npm run test:integration -w @syntholo/api -- coach-queue.integration.test.ts
```

Expected: PASS with deterministic round-robin choice and one SLA event per cycle/type.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: add coach queue and SLA tracking"
```

### Task 4: Build member support and coach queue interfaces

**Files:**
- Modify: `apps/web/src/app/learn/support/page.tsx`
- Modify: `apps/web/src/features/support/support-inbox.tsx`
- Create: `apps/web/src/app/coach/layout.tsx`
- Create: `apps/web/src/app/coach/queue/page.tsx`
- Create: `apps/web/src/app/coach/queue/[threadId]/page.tsx`
- Create: `apps/web/src/features/support/coach-queue.tsx`
- Create: `apps/web/src/features/support/coach-queue.test.tsx`
- Create: `apps/web/tests/e2e/support.spec.ts`

**Interfaces:**
- Member UI consumes only member support routes; coach UI consumes only Cloudflare Access staff routes.
- Coach queue exposes due time, warning/breach, waiting state, account members, exact artifact version, and relevant session context; it omits commerce/card/refund/revenue fields.

- [ ] **Step 1: Write component/browser RED tests**

Test shared teammate history, first message status, assigned queue ordering, pause/resume, warning/breach presentation, audited reassignment reason, and coach denial from admin-only pages.

```tsx
it("orders the coach queue by SLA urgency", () => {
  render(<CoachQueue threads={[thread({ id: "later", dueAt: hour(8) }), thread({ id: "first", dueAt: hour(2) })]} />);
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(expect.arrayContaining(["first", "later"]));
  expect(screen.getAllByTestId("queue-thread")[0]).toHaveTextContent("first");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/web -- support coach-queue && npm run test:e2e -w @syntholo/web -- support.spec.ts`

Expected: FAIL because member and coach screens still consume demo data.

- [ ] **Step 3: Replace demo reads/writes with typed API calls**

Keep the approved visual density/typography. Add accessible live message updates, optimistic send with failed/unsynced status, and explicit degraded mode without demo fallback.

```tsx
export function SupportComposer({ threadId, api }: Props) {
  const [state, send] = useOptimisticMessage(api);
  return (
    <form onSubmit={(event) => { event.preventDefault(); void send(threadId, new FormData(event.currentTarget)); }}>
      <label htmlFor="support-message">Message your coach</label>
      <textarea id="support-message" name="message" required maxLength={5_000} />
      <Button type="submit">Send message</Button>
      <p role="status" aria-live="polite">{messageDeliveryCopy(state)}</p>
    </form>
  );
}
```

- [ ] **Step 4: Run GREEN desktop/mobile**

```bash
npm test -w @syntholo/web -- support
npm run test:e2e -w @syntholo/web -- support.spec.ts
```

Expected: PASS in desktop/mobile projects for member and coach roles.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add member and coach support workspaces"
```

### Task 5: Enforce the one-active-artifact-review state machine

**Files:**
- Create: `packages/domain/src/reviews/state.ts`
- Create: `packages/domain/src/reviews/state.test.ts`
- Create: `packages/database/src/schema/reviews.ts`
- Create: `packages/database/drizzle/0019_review_lock.sql`
- Create: `packages/database/src/repositories/reviews.ts`
- Create: `apps/api/src/modules/reviews/{submit,start,return}.ts`
- Create: `apps/api/src/routes/{member,staff}/reviews.ts`
- Create: `apps/api/src/modules/reviews/reviews.integration.test.ts`
- Modify: `apps/web/src/app/learn/plan/page.tsx`
- Modify: `apps/web/src/app/coach/queue/[threadId]/page.tsx`

**Interfaces:**
- Review states are exactly `none | submitted | in_review | returned`.
- One partial unique index permits at most one row per `accountId` where state is `submitted` or `in_review`.
- Submission references immutable `artifactVersionId`; return records coach feedback and releases the lock.

- [ ] **Step 1: Write state and race RED tests**

Submit valid artifact; second artifact denied; two simultaneous submissions yield one success; coach starts; wrong coach denied unless reassigned; return exact version; new submission allowed afterward.

```ts
it("permits one active review per account under race", async () => {
  const results = await Promise.allSettled([
    submitReview(command({ artifactVersionId: "version_a" }), deps),
    submitReview(command({ artifactVersionId: "version_b" }), deps),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await reviews.countActive(accountId)).toBe(1);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/reviews/state.test.ts && npm run test:integration -w @syntholo/api -- reviews.integration.test.ts`

Expected: FAIL because the database-backed review lock does not exist.

- [ ] **Step 3: Implement state machine, constraint, and audited routes**

Member can submit with support access; coach/admin transitions are Access-protected. Audit records IDs/state only, not artifact or feedback content.

```ts
export function transitionReview(review: Review, action: ReviewAction): Review {
  const next = {
    none: { submit: "submitted" },
    submitted: { start: "in_review" },
    in_review: { return: "returned" },
    returned: { submit: "submitted" },
  }[review.state][action];
  if (!next) throw new DomainError("INVALID_REVIEW_TRANSITION");
  return { ...review, state: next };
}
```

```sql
CREATE UNIQUE INDEX one_active_review_per_account
  ON artifact_reviews (account_id)
  WHERE state IN ('submitted', 'in_review');
```

- [ ] **Step 4: Wire member/coach UI and run GREEN**

```tsx
export function ReviewStatus({ review }: { review: ArtifactReview | null }) {
  const copy = review ? REVIEW_STATUS_COPY[review.state] : "No artifact is in review";
  return <p role="status">{copy}</p>;
}
```

Run: `npm test -w @syntholo/domain -- src/reviews/state.test.ts && npm run test:integration -w @syntholo/api -- reviews.integration.test.ts && npm test -w @syntholo/web -- reviews`

Expected: PASS with one active review per account under concurrency.

- [ ] **Step 5: Commit**

```bash
git add apps packages
git commit -m "feat: lock artifact review queue per account"
```

### Task 6: Add quarantined attachments and malware scanning

**Files:**
- Create: `packages/contracts/src/support/attachments.ts`
- Create: `packages/database/src/schema/attachments.ts`
- Create: `packages/database/drizzle/0020_attachments.sql`
- Create: `packages/integrations/src/blob/{port,vercel}.ts`
- Create: `packages/integrations/src/clamav/{port,client}.ts`
- Create: `apps/api/src/modules/files/{begin-upload,download}.ts`
- Create: `apps/api/src/routes/member/files.ts`
- Create: `apps/worker/src/handlers/files/scan.ts`
- Create: `apps/worker/src/handlers/files/scan.integration.test.ts`
- Modify: `infra/docker-compose.test.yml`
- Modify: `apps/worker/Dockerfile`

**Interfaces:**
- Attachment states `pending_upload | quarantined | scanning | clean | rejected | scan_failed`.
- Accepts ≤25 MB and allowlisted extension/MIME pairs; verifies actual detected MIME after upload.
- Only `clean` objects receive five-minute signed downloads after account/staff authorization.

- [ ] **Step 1: Write file-boundary RED tests**

Cover oversize, extension/MIME mismatch, EICAR test file, clean file, scan timeout/retry, unauthorized download, quarantined download denial, and expired signed URL.

```ts
it("rejects EICAR and never creates a download", async () => {
  const attachment = await seedQuarantinedAttachment(EICAR_BYTES);
  await scanAttachment(jobFor(attachment), deps);
  expect(await attachments.get(attachment.id)).toMatchObject({ state: "rejected" });
  await expect(createDownload(command({ attachmentId: attachment.id }), deps)).rejects.toMatchObject({ code: "FILE_NOT_CLEAN" });
});

it("rejects files larger than 25 MB", () => {
  expect(() => validateUpload({ size: 25 * 1024 * 1024 + 1, name: "large.pdf", mime: "application/pdf" })).toThrow("FILE_TOO_LARGE");
});
```

- [ ] **Step 2: Run RED with PostgreSQL and ClamAV services**

Run: `docker compose -f infra/docker-compose.test.yml up -d postgres clamav && npm run test:integration -w @syntholo/worker -- scan.integration.test.ts`

Expected: FAIL because quarantine storage and the scan handler do not exist.

- [ ] **Step 3: Implement quarantine-first upload and scan handler**

Generate a private quarantine object key server-side. Worker streams bytes through current ClamAV signatures, moves/copies clean content to a private clean prefix, and marks rejected files without making them downloadable.

```ts
export async function scanAttachment(job: ScanAttachmentJob, deps: FileDeps) {
  const attachment = await deps.attachments.claimForScan(job.attachmentId);
  const bytes = deps.blob.stream(attachment.quarantineKey);
  const result = await deps.clamav.scan(bytes);
  if (result.status === "infected") return deps.attachments.reject(attachment.id, result.signature);
  if (result.status === "error") throw new RetryableJobError("MALWARE_SCAN_UNAVAILABLE");
  const cleanKey = `clean/${attachment.accountId}/${attachment.id}`;
  await deps.blob.copyPrivate(attachment.quarantineKey, cleanKey);
  await deps.attachments.markClean(attachment.id, cleanKey, result.detectedMime);
}
```

- [ ] **Step 4: Add safe support attachment UI and run GREEN**

Display scan state and failure recovery; never put original private file names in PostHog/Sentry.

```tsx
export function AttachmentStatus({ attachment }: { attachment: AttachmentSummary }) {
  return <div>
    <span>{attachment.displayName}</span>
    <span role="status">{ATTACHMENT_STATE_COPY[attachment.state]}</span>
    {attachment.state === "clean" ? <a href={`/api/files/${attachment.id}/download`}>Download</a> : null}
  </div>;
}
```

Run: `npm run test:integration -w @syntholo/worker -- scan.integration.test.ts && npm test -w @syntholo/web -- attachments`

Expected: PASS; infected/quarantined files never expose a download and clean files do.

- [ ] **Step 5: Commit**

```bash
git add apps packages infra
git commit -m "feat: quarantine and scan private uploads"
```

### Task 7: Model Pilot and office-hours sessions, RSVP, waitlist, and attendance

**Files:**
- Create: `packages/domain/src/sessions/{schedule,rsvp}.ts`
- Create: `packages/domain/src/sessions/{schedule,rsvp}.test.ts`
- Create: `packages/contracts/src/sessions/sessions.ts`
- Create: `packages/database/src/schema/sessions.ts`
- Create: `packages/database/drizzle/0021_sessions.sql`
- Create: `packages/database/src/repositories/sessions.ts`
- Create: `apps/api/src/modules/sessions/{generate,list,rsvp,cancel,attendance}.ts`
- Create: `apps/api/src/routes/{member,staff}/sessions.ts`
- Create: `apps/api/src/modules/sessions/sessions.integration.test.ts`

**Interfaces:**
- Pilot generation creates exactly four weekly session instances from cohort start and timezone.
- Office-hours recurrence creates Americas and Europe/Asia slots; member display always includes stored IANA timezone and localized value.
- RSVP states `confirmed | waitlisted | canceled | attended | absent`; cancellation promotes the oldest waitlisted RSVP transactionally.

- [ ] **Step 1: Write recurrence/capacity RED tests**

Cover DST transitions, four Pilot instances, two regional office-hour series, duplicate generation, capacity, concurrent final seat, waitlist order, cancel/promotion, and attendance permissions.

```ts
it("generates four weekly Pilot sessions exactly once", async () => {
  await generatePilotSessions(command({ cohortId, startAt, timeZone: "America/New_York" }), deps);
  await generatePilotSessions(command({ cohortId, startAt, timeZone: "America/New_York" }), deps);
  expect(await sessions.listForCohort(cohortId)).toHaveLength(4);
});

it("promotes the oldest waitlisted RSVP", async () => {
  await cancelRsvp(command({ rsvpId: confirmedId }), deps);
  expect(await rsvps.get(oldestWaitlistedId)).toMatchObject({ status: "confirmed" });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/sessions && npm run test:integration -w @syntholo/api -- sessions.integration.test.ts`

Expected: FAIL because recurrence, RSVP, waitlist, and attendance persistence do not exist.

- [ ] **Step 3: Implement deterministic recurrence and transactions**

Store canonical UTC start/end plus source timezone and recurrence key. Unique `(series_id, occurrence_key)` makes generation idempotent.

```ts
export function pilotOccurrences(start: ZonedDateTime): readonly SessionOccurrence[] {
  return Array.from({ length: 4 }, (_, index) => ({
    occurrenceKey: `pilot-week-${index + 1}`,
    startsAt: start.add({ weeks: index }).toInstant().toString(),
    sourceTimeZone: start.timeZoneId,
  }));
}
```

Store `recordingAssetId` and `recordingPublishedAt` as nullable protected metadata; recording publication uses the same entitlement check as the session series.

- [ ] **Step 4: Run GREEN**

```bash
npm test -w @syntholo/domain -- src/sessions
npm run test:integration -w @syntholo/api -- sessions.integration.test.ts
```

Expected: PASS for four Pilot sessions, regional office hours, capacity, waitlist promotion, attendance, and recording metadata.

- [ ] **Step 5: Commit**

```bash
git add apps packages
git commit -m "feat: schedule cohorts and office hours"
```

### Task 8: Add protected manual Zoom links, calendar data, and reminders

**Files:**
- Create: `packages/contracts/src/sessions/join.ts`
- Create: `packages/database/src/schema/session-delivery.ts`
- Create: `packages/database/drizzle/0022_session_delivery.sql`
- Create: `apps/api/src/modules/sessions/{set-join-metadata,get-join,record-incident}.ts`
- Create: `apps/worker/src/handlers/sessions/{enqueue-reminders,send-reminder}.ts`
- Create: `apps/worker/src/handlers/sessions/reminders.integration.test.ts`
- Modify: `apps/web/src/app/learn/live/page.tsx`
- Create: `apps/web/src/app/admin/sessions/page.tsx`
- Create: `docs/operations/session-scheduling.md`

**Interfaces:**
- Admin-only recent-auth command stores encrypted/protected join metadata and records no secret in audit.
- Member join action becomes available 15 minutes before start and only for authorized confirmed attendees.
- Worker sends calendar payload on confirmation plus 24-hour and one-hour reminders, each with unique delivery key.
- Incident types `missing_link | wrong_link | timezone_error`; operations report evaluates approved automation triggers.

- [ ] **Step 1: Write join-window/reminder/trigger RED tests**

Cover unauthorized member, waitlisted member, 16 vs 15 minutes, expired session, duplicate reminder sweep, timezone rendering, two incidents in 90 days, three concurrent cohorts, and >2 staff-hours threshold.

```ts
it.each([[16, false], [15, true]])("opens join at the 15-minute boundary", (minutesBefore, allowed) => {
  expect(canJoin({ now: minute(-minutesBefore), startsAt: minute(0), rsvpStatus: "confirmed" })).toBe(allowed);
});

it("triggers Zoom automation after two incidents", () => {
  expect(evaluateZoomAutomationTrigger({ concurrentCohorts: 1, incidentsIn90Days: 2, staffMinutesThisMonth: 20 }).triggered).toBe(true);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/sessions && npm run test:integration -w @syntholo/worker -- reminders.integration.test.ts`

Expected: FAIL because protected join metadata, reminders, and trigger reporting do not exist.

- [ ] **Step 3: Implement metadata protection, calendar output, and durable reminders**

Never return join metadata in session list responses; fetch through a separate authorization endpoint. Record scheduling minutes per session to support the explicit automation trigger.

```ts
export function canJoin(input: { now: Date; startsAt: Date; endsAt: Date; rsvpStatus: RsvpStatus }): boolean {
  return input.rsvpStatus === "confirmed" && input.now >= addMinutes(input.startsAt, -15) && input.now <= input.endsAt;
}

export const reminderKey = (sessionId: string, recipientId: string, offset: "24h" | "1h") =>
  `session:${sessionId}:recipient:${recipientId}:offset:${offset}`;
```

- [ ] **Step 4: Update UI/runbook and run GREEN**

Run: `npm test -w @syntholo/domain -- src/sessions && npm run test:integration -w @syntholo/worker -- reminders.integration.test.ts && npm test -w @syntholo/web -- live-schedule`

Expected: PASS for join window, protected metadata, reminder idempotency, timezone rendering, and automation triggers.

- [ ] **Step 5: Commit**

```bash
git add apps packages docs/operations
git commit -m "feat: operate manually linked live sessions"
```

### Task 9: Implement Clerk-to-Circle SSO and entitlement access synchronization

**Files:**
- Create: `packages/contracts/src/community/access.ts`
- Create: `packages/domain/src/community/access.ts`
- Create: `packages/domain/src/community/access.test.ts`
- Create: `packages/database/src/schema/community.ts`
- Create: `packages/database/drizzle/0023_community.sql`
- Create: `packages/integrations/src/circle/{port,adapter}.ts`
- Create: `apps/worker/src/handlers/community/sync-access.ts`
- Create: `apps/worker/src/handlers/community/sync-access.integration.test.ts`
- Create: `apps/api/src/routes/member/community.ts`
- Modify: `apps/web/src/app/learn/community/page.tsx`
- Create: `docs/operations/circle.md`

**Interfaces:**
- Input is effective `support`/`circle_write` access plus active membership; desired group is `write | read_only | none`.
- Worker synchronizes server-side through Circle Admin API, stores external member/group IDs and delivery state only, and never reads/writes posts.
- Member route returns Circle handoff URL and sync state; Clerk is configured as Circle OAuth provider outside code.

- [ ] **Step 1: Write access-matrix/retry RED tests**

Included support → write; support expiry → read-only; Operator Club → write; restoration → write; refunded-only account → none; Circle outage → retry/dead-letter without Academy/support outage.

```ts
it.each([
  [{ support: true, club: false, activeMember: true, qualifyingAcademyPurchase: true }, "write"],
  [{ support: false, club: false, activeMember: true, qualifyingAcademyPurchase: true }, "read_only"],
  [{ support: false, club: true, activeMember: true, qualifyingAcademyPurchase: true }, "write"],
  [{ support: true, club: true, activeMember: false, qualifyingAcademyPurchase: true }, "none"],
  [{ support: false, club: false, activeMember: true, qualifyingAcademyPurchase: false }, "none"],
])("maps entitlement state to Circle access", (input, expected) => {
  expect(desiredCircleAccess(input)).toBe(expected);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/community && npm run test:integration -w @syntholo/worker -- sync-access.integration.test.ts`

Expected: FAIL because Circle desired-state synchronization does not exist.

- [ ] **Step 3: Implement pure desired-state mapping and idempotent adapter calls**

Emit sync request whenever relevant grants/membership change. Store one desired/current projection and a delivery receipt per event; never mirror Circle content.

```ts
export function desiredCircleAccess(input: CircleAccessInput): CircleAccess {
  if (!input.activeMember || !input.qualifyingAcademyPurchase) return "none";
  if (input.support || input.club) return "write";
  return "read_only";
}

export async function syncCircleAccess(job: CircleSyncJob, deps: CommunityDeps) {
  const state = await deps.community.get(job.membershipId);
  await deps.circle.setAccessGroup(state.circleMemberId, deps.groupId[state.desiredAccess], job.eventId);
  await deps.community.markCurrent(job.membershipId, state.desiredAccess, job.eventId);
}
```

- [ ] **Step 4: Add handoff UI and operations runbook**

Show temporary sync state and retry-safe guidance. Document Circle Business plan, production groups, OAuth redirect URLs, and manual recovery.

```tsx
export function CircleHandoff({ handoff }: { handoff: CircleHandoff }) {
  if (handoff.syncState === "pending") return <p role="status">Your community access is syncing.</p>;
  if (handoff.syncState === "failed") return <Alert role="alert">Community access needs attention; your Academy remains available.</Alert>;
  return <a href={handoff.url}>Open the Syntholo community</a>;
}
```

- [ ] **Step 5: Run GREEN**

```bash
npm test -w @syntholo/domain -- src/community
npm run test:integration -w @syntholo/worker -- sync-access.integration.test.ts
```

Expected: PASS; Circle failures retry independently and Academy/support remain available.

- [ ] **Step 6: Commit**

```bash
git add apps packages docs/operations
git commit -m "feat: synchronize Circle community access"
```

### Task 10: Complete Flow 3, sessions, and Circle gate evidence

**Files:**
- Create: `apps/web/tests/e2e/human-operations.spec.ts`
- Create: `apps/web/tests/e2e/sessions-community.spec.ts`
- Create: `infra/scripts/gate-human-operations.mjs`
- Create: `docs/operations/coach-queue.md`
- Modify: `package.json`

**Interfaces:**
- Produces `npm run gate:human-operations` covering account-shared support, SLA, review lock, scanning, sessions, reminder idempotency, and Circle degradation.

- [ ] **Step 1: Add failing cross-surface journeys**

Owner/thread → teammate/shared reply → coach assignment → waiting pause/resume → substantive response; concurrent artifact reviews; infected/clean upload; Pilot/office-hours RSVP; join window; Circle write/read-only transitions.

```ts
test("one account shares support and only one artifact review", async ({ browser }) => {
  const owner = await memberPage(browser, "owner");
  const teammate = await memberPage(browser, "teammate");
  await owner.goto("/learn/support");
  await owner.getByLabel("Message your coach").fill("Please review our workflow");
  await owner.getByRole("button", { name: "Send message" }).click();
  await teammate.goto("/learn/support");
  await expect(teammate.getByText("Please review our workflow")).toBeVisible();
  const results = await Promise.allSettled([submitReview(owner), submitReview(teammate)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
});
```

- [ ] **Step 2: Run RED and close route/UI gaps**

Run: `npm run test:e2e -w @syntholo/web -- human-operations.spec.ts sessions-community.spec.ts`

Expected: FAIL until support, review, attachment, session, and Circle journeys use production APIs.

Use these exact cross-surface clients while wiring gaps:

```ts
export interface HumanOperationsApi {
  sendSupportMessage(threadId: string, body: string, idempotencyKey: string): Promise<SupportMessage>;
  submitArtifactReview(artifactVersionId: string, idempotencyKey: string): Promise<ArtifactReview>;
  rsvp(sessionId: string, idempotencyKey: string): Promise<Rsvp>;
  getCircleHandoff(): Promise<{ url: string; syncState: "ready" | "pending" | "failed" }>;
}
```

- [ ] **Step 3: Run full verification**

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e -w @syntholo/web -- human-operations.spec.ts sessions-community.spec.ts
npm run gate:human-operations
git diff --check
```

Expected: all pass; Circle failure does not affect Academy/support; one review lock wins under race.

- [ ] **Step 4: Self-review**

Confirm account-owned threads, no coach commerce leakage, correct business calendar, scan-before-download, protected join metadata, explicit Zoom triggers, and zero Circle content mirroring.

- [ ] **Step 5: Commit**

```bash
git add apps packages infra docs/operations package.json
git commit -m "test: verify human operations and community"
```
