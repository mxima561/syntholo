# Syntholo Production Launch PRD Addendum

**Product:** Syntholo AI Operating System Academy
**Version:** 1.1 production architecture addendum
**Status:** Approved design; pending final document review
**Date:** 2026-08-12
**Capacity target:** 50–250 customer businesses
**Related documents:** [Product PRD](../../product/prd.md), [Product design](../../../design.md), [Demo and production runbook](../../operations/demo-and-production.md)

## 1. Purpose and precedence

This addendum turns the current polished, deterministic demo into a production system. It defines the approved backend-first architecture, account and entitlement boundaries, critical user flows, operating safeguards, deployment topology, launch gates, and acquisition measurement.

Where this addendum conflicts with the original PRD or runbook, this addendum controls. In particular, it replaces the original single-provider WorkOS customer identity model, MongoDB application datastore, in-app community implementation, flat integration diagram, and certificate exclusion. The existing visual design and deterministic demo remain the reference experience while production modules are built behind stable contracts.

## 2. Approved launch model

Syntholo launches one production platform with four paid offers and two Academy enrollment paths:

| Offer | Entry | Price | Production rule |
|---|---|---:|---|
| Readiness Scorecard | Public native funnel | Free | Captures a consented lead and report; creates no paid access grant. |
| Guided Pilot | Native application, admin approval, private checkout | $750 once | Three seats, lifetime Academy access, 12 months of support/community, one fixed four-week cohort. |
| Self-Paced Academy | Public native sales page and checkout | $399 once | Three seats, lifetime Academy access, 12 months of support/community, recurring office hours. |
| Operator Club | Existing Academy accounts only | $59/month or $590/year | Extends support, Circle write access, playbooks, and office hours. If selected before included support expires, billing and the renewal grant begin at expiry. |
| Business OS | Public offer, checkout gated by operational readiness | $999 setup + $199/month | Separate HighLevel service, onboarding, provisioning, recurring billing, and external login. It never gates Academy access. |

All customer acquisition funnels live on the Syntholo domain. Self-Paced can be purchased immediately only after the launch gates pass. Guided Pilot requires application approval, cohort assignment, and an expiring private Stripe checkout link. Operator Club is not a standalone course purchase. Business OS checkout remains disabled until the HighLevel agency account, approved reusable snapshot, operating process, and seven activation checks are ready.

Business OS does not bundle Academy course access or Operator Club. Those grants apply only when the account owns their separate qualifying purchase. Business OS state remains independent even when one account owns several offers.

Public marketing pages, the readiness scorecard, and a consented waitlist or Pilot application may operate before paid launch. No Academy payment is enabled until all 18 required lessons pass the content-completion gate in section 17.

## 3. Monorepo and deployable applications

The production codebase remains one Git repository with independently deployable services:

```text
syntholo/
├── apps/
│   ├── web/           Next.js public, member, coach, and admin interface
│   ├── api/           TypeScript/Fastify production API and webhooks
│   └── worker/        Durable jobs, notifications, synchronization, and cron tasks
├── packages/
│   ├── domain/        Framework-independent business rules and state machines
│   ├── contracts/     Versioned, validated API request/response schemas
│   ├── database/      PostgreSQL schema, migrations, repositories, and indexes
│   ├── integrations/  Vendor adapters with no UI imports
│   └── testing/       Factories, identity fixtures, and contract-test helpers
└── docs/              Product, architecture, operations, and incident guidance
```

Repository structure does not couple runtime capacity. The web, API, worker, and cron processes deploy and scale independently. Shared contracts allow one pull request to change a domain rule, API response, and consuming interface without publishing loosely coordinated packages. A service moves to a separate repository only after team ownership or operational isolation creates a demonstrated need.

The existing Next.js application becomes `apps/web`. During migration, production features consume the API while unfinished areas continue to use explicit demo fixtures in non-production mode. Production mode must fail closed; it must never fall back to demo records after a database or vendor failure.

## 4. Product surfaces and identity boundaries

The system has four explicit application surfaces:

| Surface | Users | Identity | Primary capabilities |
|---|---|---|---|
| Public | Visitors and applicants | Anonymous, then Clerk at claim/sign-in | Marketing, scorecard, Pilot application, pricing, checkout entry, legal pages. |
| Member | Customer owner and up to two teammates | Clerk | Academy, progress, shared outputs, support, sessions, Circle handoff, settings, billing status, Business OS status. |
| Coach | Human coaching staff | WorkOS | Assigned queue, SLA state, account context, artifact review, session attendance, and community moderation escalation. |
| Admin | Authorized operations staff | WorkOS with mandatory MFA | Applications, cohorts, content, commerce, entitlements, users, sessions, coaches, audit, and Business OS provisioning. |

Clerk handles member magic links, Google/Microsoft or other approved social sign-in, account claim, and consumer sessions. WorkOS handles staff identity, staff RBAC, audit-relevant identity events, and future workforce SSO. The providers are deliberately not unified.

The API accepts separate issuer and audience configurations for Clerk member tokens and WorkOS staff sessions. Member middleware cannot authorize coach/admin routes, and staff middleware cannot silently act as a member. If a person has both relationships, the identities and sessions remain separate. Every authenticated request resolves an immutable internal actor, account or staff scope, role, and effective authorization before reaching a repository.

Customer-owned records are scoped by immutable `accountId`. Staff access is role-checked and audited. Coaches cannot access commerce, refunds, entitlements, staff administration, or unrestricted customer exports. Admin actions that change roles, access, money, content publication, moderation, or activation require recent authentication and record actor, reason, and timestamp.

## 5. API and module boundaries

The production API is the sole business-write authority. The web interface contains no database credentials, Stripe secret, WorkOS secret, Circle admin token, HighLevel credential, Mux secret, Resend key, Blob write token, or staff-only business logic.

The API exposes separately protected public, member, staff, and webhook routes. Requests and responses use schemas from `packages/contracts`; malformed requests fail before domain mutation. The API returns stable error codes, a customer-safe message, and a correlation ID. Internal stack traces, provider payloads, and secrets never reach the browser.

Domain modules have one responsibility each:

- **Identity and accounts:** external identity mapping, account claim, membership, invitations, ownership transfer, and staff profiles.
- **Entitlements:** commercial access grants, seat capacity, support window, Circle access state, administrative holds, and Business OS availability.
- **Commerce:** offers, Stripe customers, checkout sessions, purchases, subscriptions, invoices, refunds, disputes, and webhook receipts.
- **Applications and cohorts:** Guided Pilot applications, review decisions, cohort assignment, capacity, and private checkout eligibility.
- **Content:** course, stage, lesson, version, structured content blocks, video/caption readiness, publication, archive, and release schedule.
- **Learning:** enrollment, personal lesson progress, resume position, completion calculation, and certificate issuance.
- **Implementation:** organization-shared artifacts, versions, optimistic concurrency, workflow records, and review requests.
- **Support:** account-owned threads, messages, attachments, coach assignment, SLA events, and resolution.
- **Sessions:** Pilot cadence, office-hours recurrence, RSVP, waitlist, attendance, reminders, join availability, and recording metadata.
- **Community:** entitlement-to-Circle access synchronization only; community posts and comments remain in Circle.
- **Business OS:** Syntholo onboarding, provisioning workflow, seven-check evidence, recurring verification, and external-login status.
- **Operations:** durable jobs, audit events, notifications, health, incident state, and administrative reporting.

Modules communicate through typed commands, queries, and domain events. UI components do not compute entitlement or state-transition rules.

## 6. PostgreSQL system of record

PostgreSQL is the only Syntholo application database. MongoDB is removed from the production architecture. Flexible lesson blocks use PostgreSQL `jsonb`; they do not justify a second operational datastore.

Core relational groups include:

- accounts, member identities, staff identities, memberships, invitations, and ownership transfers;
- offers, prices, Stripe customers, purchases, subscriptions, invoices, refunds, disputes, and webhook receipts;
- entitlement grants, seat assignments, support windows, Circle sync state, and administrative holds;
- applications, review decisions, cohorts, cohort enrollments, and session instances;
- courses, course versions, stages, lessons, lesson versions, content blocks, assets, publication events, and disclosures;
- enrollments, progress, resume position, completion events, certificate records, and certificate files;
- artifacts, artifact versions, workflow records, review state, and review locks;
- support threads, messages, assignments, SLA events, attachment scans, and resolutions;
- Business OS onboarding, provisioning, check evidence, verification runs, incidents, and external-login metadata;
- outbox events, jobs, attempts, dead-letter state, notification deliveries, analytics delivery, and immutable audit events.

Every customer-owned row carries `accountId`. Repository methods require scope explicitly; cross-account reads are not expressible through unscoped helpers. PostgreSQL row-level security is required on all customer-owned tables reached by the member-facing database role. Staff and worker operations use separate least-privilege roles, explicit account scope where applicable, and audited cross-account actions. Row-level security does not replace scoped repositories or authorization tests. Financial IDs, provider event IDs, invitation tokens, claim tokens, idempotency keys, active review locks, and other uniqueness rules are enforced by database constraints, not application convention.

The API writes a domain mutation and its outbox event in one transaction. Workers claim jobs with safe concurrent locking, use idempotency keys, retry transient failures with bounded exponential backoff, and move exhausted jobs to an operations-visible dead-letter queue.

## 7. Entitlement authority

Entitlements are a dedicated domain module and central access authority. They are not conditionals scattered across pages or route handlers.

An account can own several products simultaneously, so access is represented by composable, source-linked grants rather than one mutually exclusive tier enum. The authority evaluates:

- Academy course access;
- support access and expiration;
- Circle read/write status;
- Operator Club benefits;
- Business OS provisioning and external-login availability;
- seat capacity and assignment;
- payment grace, refund/revocation, and administrative holds.

Grant records identify the offer, transaction or administrative source, effective dates, status, and audit provenance. Supported statuses include `active`, `grace`, `expired`, `refunded`, and `revoked`. An access decision is explainable from its contributing grants.

Hard invariants:

1. A paid Academy account has at most three reserved or active seats.
2. The purchaser claims seat one as owner. Pending invitations reserve the other seats and expire after seven days.
3. Owners may resend, revoke, replace, and reassign teammate seats and may transfer ownership after recent authentication.
4. A non-refunded Guided Pilot or Self-Paced purchase provides lifetime course access.
5. Included support and Circle write access expire 12 months after the Academy purchase unless an Operator Club grant applies.
6. Operator Club is available only to an account with a valid Academy purchase. If scheduled early, billing and renewed benefits start when included support ends.
7. Business OS is a separate grant and state machine. Its purchase, provisioning, degradation, suspension, or cancellation never gates Academy access.
8. UI-only flags cannot grant access. Every effective grant has a durable source and audit event.
9. Refunds, disputes, cancellations, and seat changes never delete progress, certificate, financial, or audit history.

## 8. Progress, completion, and certificates

Certificates are earned achievement records, not entitlement grants.

Personal progress belongs to a member and enrollment. Shared business outputs belong to the account. A member becomes certificate-eligible after completing all 18 required published lessons for the enrolled course version. Video watching is not mandatory because the transcript is an equivalent path. Content published later does not revoke a prior completion or certificate.

On first eligibility, the learning module records an immutable completion fact, enqueues one certificate job, generates an unaccredited PDF, stores it privately, and emails or exposes a signed download to the member. The PDF identifies the member, business, course, course version, and completion date. V1 has no public verification lookup, certificate ID system, or accreditation claim.

Certificate issuance depends only on lesson-completion state. Purchase tier, support-window expiry, refund, dispute, seat reassignment, and Business OS state do not revoke an issued certificate or delete its record. A refunded or removed member may lose application access, but the earned record and delivered PDF persist.

## 9. Production-critical flows

### Flow 1 — Self-Paced purchase and activation

1. A visitor lands on a native campaign page; Syntholo records consent-appropriate UTM and scorecard context.
2. The visitor starts the public $399 Stripe Checkout.
3. Stripe sends a signed webhook. The API claims the provider/event ID before mutation; replay returns success without duplicate fulfillment.
4. One transaction creates the pending purchase, account, three-seat Academy grant, 12-month support/community window, enrollment, claim token, receipt job, and audit event.
5. The buyer follows the claim link, authenticates through Clerk, and proves the verified checkout email. The token is single-use and expires after seven days.
6. The owner completes onboarding, claims seat one, invites up to two teammates, and starts the Academy.

### Flow 2 — Guided Pilot application and private checkout

1. A visitor completes the native Pilot application with business fit, goals, readiness, availability, and campaign attribution.
2. A WorkOS-authenticated admin reviews the application, requests information, approves, or declines with an audited decision.
3. Approval requires a cohort assignment and available capacity.
4. The worker emails an expiring private $750 Stripe Checkout link with the seven-day refund disclosure and cohort terms.
5. Signed, idempotent payment fulfillment creates the Pilot purchase, three seats, lifetime Academy access, 12 months support/community, cohort enrollment, account claim, and notifications.

### Flow 3 — Human support and artifact review

1. A support thread belongs to the account, so its owner and active teammates share the same history.
2. The first customer message records the SLA start and round-robin assigns an available coach.
3. The two-U.S.-business-day substantive-response clock warns operations during the final eight business hours, pauses in `waiting_on_customer`, resumes on customer reply, and records breach or satisfaction.
4. Coaches reply, request customer action, resolve, reopen, and close through audited transitions.
5. Artifact review states are `none`, `submitted`, `in_review`, and `returned`. A database lock prevents more than one `submitted` or `in_review` artifact per account.
6. A returned review identifies the exact artifact version and releases the lock. Vercel Blob stores file bytes; PostgreSQL owns review state.

### Flow 4 — Lesson publishing and certificate issuance

1. A WorkOS admin drafts structured lesson content, selects its course/stage/order/release rule, and adds action, resources, and required disclosures.
2. Mux processing reaches ready state; captions and transcript are attached.
3. Publication validation requires title, summary, ready video, captions, transcript, duration, action, resources, accessibility review, and required commercial disclosure.
4. Admin preview and publication create an immutable lesson version and audit event. Published versions with progress are archived or superseded, not edited in place.
5. Members record personal completion. Shared outputs remain account-owned and versioned.
6. Completion of the 18 required lessons records an achievement and asynchronously generates the certificate described in section 8.

### Flow 5 — Recurring products and Business OS

1. An eligible Academy account selects Operator Club monthly or annual renewal.
2. If included support remains active, Stripe schedules billing for its expiry; otherwise the subscription begins immediately.
3. Invoice success, payment failure, cancellation, and renewal update only Operator Club-derived support and Circle grants.
4. Business OS Checkout is enabled only after the HighLevel readiness dependency and all pre-sale disclosures pass.
5. Payment creates Syntholo onboarding and provisioning records. HighLevel work occurs under separate authentication.
6. Syntholo records questionnaire state, SLA state, seven-check evidence, customer notices, and the external HighLevel login hyperlink. It never mirrors HighLevel customer data.

### Flow 6 — Refund, cancellation, payment failure, and dispute

1. A customer request or signed Stripe event opens a commerce case for refund, cancellation, failed invoice, or dispute.
2. The API claims the provider/event ID before mutation.
3. A WorkOS admin reviews policy, payment facts, timeline, and prior actions when a human decision is required.
4. Stripe performs the refund, schedules cancellation, retries a failed invoice, or reports dispute status.
5. The entitlement authority recomputes only the grants sourced from that transaction.
6. The worker sends an exact access-impact notice; every request, decision, provider action, grant transition, and delivery is audited.

Policy outcomes:

- **Academy refund:** Guided Pilot and Self-Paced purchases have an unconditional seven-day refund window, subject to mandatory law. An approved full refund marks transaction-sourced course, support, and community grants refunded and releases its seats. It preserves the account, progress, previously issued certificates, financial records, and audit history.
- **Operator Club failure/cancellation:** failed payment enters seven days of grace; day eight restricts only Club-derived benefits. Cancellation applies at the paid term's end. Lifetime Academy access is unchanged.
- **Business OS refund/cancellation:** onboarding is refundable until provisioning starts. Cancellation affects only Business OS; it never changes Academy access.
- **Dispute:** an open Stripe dispute places an administrative hold on new purchases, teammate invitations/replacements, and Business OS activation while preserving existing learning access. A won dispute clears the hold. A lost dispute revokes only grants sourced from the disputed transaction.

## 10. Admin content system and lesson launch gate

Lessons are managed in the Syntholo admin editor, not hard-coded or imported as an opaque bulk document. The editor supports course, stage, lesson, drag ordering, reusable content blocks, release rules, `draft`, `preview`, `scheduled`, `published`, and `archived` states, plus version history.

Every required lesson contains:

- a 5–12 minute Mux video with signed playback;
- captions and a complete transcript;
- title, outcome-focused summary, and duration;
- one concrete action or assignment;
- relevant private or public resources;
- any affiliate, white-label, safety, or professional-advice disclosure;
- an accessibility review and a tested mobile/desktop presentation.

No Academy payment may be enabled until all 18 required lessons satisfy these requirements and are published in the production course version. No lesson may use placeholder video, transcript, summary, action, or download. Automated publication validation and a human content checklist both gate launch.

## 11. Coach queue, sessions, and community

### Coach operations

The coach surface is separate from admin. Coaches see assigned and unassigned queue work appropriate to their role, SLA countdown, account member names, relevant purchase/support state, shared thread history, attached artifact version, and session context. They cannot see card details, refunds, revenue analytics, staff management, or unrestricted customer exports.

Round-robin assignment accounts for active/away status and current workload. Manual reassignment requires a reason. SLA warnings, breaches, waiting states, and resolution are first-class events and operational metrics.

### Native scheduling with manual Zoom links

Pilot cohorts have four weekly session instances derived from the cohort start date. Self-Paced and Operator Club have two recurring monthly office-hours instances for Americas-friendly and Europe/Asia-friendly time zones. PostgreSQL stores schedules, capacity, waitlist, RSVP, attendee timezone, reminders, join-window state, attendance, recording, and publication status.

V1 Zoom setup is manual: an admin creates the Zoom meeting and records its protected join metadata in Syntholo. The member sees local time, receives calendar data and 24-hour/one-hour reminders, and sees the join action 15 minutes before start.

Automate Zoom scheduling when the first of these triggers occurs:

- three Pilot cohorts run concurrently;
- two missed-link, wrong-link, or timezone incidents occur within 90 days; or
- manual scheduling exceeds two staff hours per month.

### Circle community

Circle is the community system of record; Syntholo does not rebuild or mirror posts, comments, reactions, or moderation content in PostgreSQL. Clerk acts as an OAuth 2.0 identity provider for Circle SSO. The worker uses Circle's server-side Admin API to synchronize entitlement-driven access groups.

During included 12-month support or active Operator Club, members receive Circle write access. After expiry, they move to the approved read-only access group. Account or Club restoration restores write access. Failed Circle synchronization enters retry/dead-letter operations state and does not block Academy or support. Circle Business plan or higher is a launch dependency for Admin API access.

## 12. Business OS isolation and operating state

HighLevel is fully isolated:

- no shared session or SSO;
- no background API or worker data pipe into customer HighLevel records;
- no mirrored contacts, messages, appointments, pipelines, or conversation content;
- no HighLevel outage may block Academy, support, or Circle;
- the member surface exposes only Syntholo onboarding/provisioning state and an external HighLevel login hyperlink.

Business OS activation requires evidence for seven named checks:

1. test lead capture;
2. lead routing;
3. calendar booking;
4. inbound and outbound messaging;
5. client onboarding;
6. AI escalation to a human;
7. dashboard reporting activity.

Each check stores status, an evidence reference that does not mirror customer data, actor, and timestamp. Activation is disabled until all seven pass.

V1 post-activation monitoring is manual. An authorized operator re-runs all seven checks monthly and after a material HighLevel change or customer-reported incident. A failed check changes Syntholo status to `degraded`, opens an operations incident, and notifies the customer without changing Academy access. Resolution records new evidence and restores `active`.

Revisit automated synthetic monitoring when the first of these triggers occurs:

- 25 active Business OS accounts;
- two customer-discovered degradations before the scheduled check within 90 days; or
- more than eight operator hours per month spent on verification.

Future automation must preserve separate authentication and avoid customer-data mirroring.

## 13. Vendor and deployment topology

| Responsibility | Approved service | Boundary |
|---|---|---|
| Web deployment | Vercel | Next.js web and static/CDN delivery; production region aligned with API/database. |
| API, worker, cron | Railway | Persistent API and worker services plus scheduled jobs; independently deployable and horizontally scalable. |
| Relational data | Neon PostgreSQL | Separate U.S. staging and production projects, pooled connections, restore window, and tested point-in-time recovery. |
| Member identity | Clerk | Consumer sign-in, claim, social/magic-link identity, sessions, and Circle OAuth provider. |
| Staff identity | WorkOS | Coach/admin sign-in, RBAC context, and mandatory admin MFA. |
| Payments | Stripe | Checkout, Billing, customer portal, refunds, disputes, invoices, and signed webhooks. |
| Video | Mux | Signed playback, processing state, thumbnails, captions, and transcript association. |
| Email | Resend | Transactional messages only through durable jobs. |
| Private files | Vercel Blob | Quarantine and clean private objects, signed downloads, and retention. |
| Community | Circle | Member community, spaces, access groups, content, and moderation. |
| Analytics | PostHog U.S. Cloud | Consent-aware product events with replay disabled and no confidential content or unnecessary PII. |
| Errors/operations | Sentry plus provider health | PII-scrubbed errors, releases, job/cron checks, alerts, and uptime monitoring. |
| Optional operating system | HighLevel | Separate customer authentication and data; no SSO or mirrored data. |

Staging and production use different vendor projects, keys, webhooks, domains, databases, storage prefixes, analytics environments, Circle access groups, and email-recipient controls. Preview deployments use synthetic data and must not receive production credentials or copied production PII.

The provider choices are based on current official capabilities: [Vercel Functions](https://vercel.com/docs/functions), [Railway build and deploy](https://docs.railway.com/build-deploy), [Neon connection pooling](https://neon.com/docs/connect/connection-pooling), [Neon restore](https://neon.com/docs/manage/projects), [Clerk OAuth provider](https://clerk.com/docs/guides/configure/auth-strategies/oauth/single-sign-on), [Circle custom SSO](https://help.circle.so/p/sso-and-integrations/sso/set-up-custom-sso), and [Circle API access](https://help.circle.so/p/sso-and-integrations/api/get-to-know-the-circle-developer-platform).

## 14. Security, privacy, and file handling

- Verify Clerk, WorkOS, Stripe, and other provider signatures against raw inputs and expected audience/issuer.
- Require recent authentication for ownership transfer, seat replacement, refund approval, role changes, exports, and destructive administration.
- Rate-limit scorecard report generation, applications, claim attempts, invitations, support writes, and checkout creation by appropriate identity and network signals.
- Use secure, HTTP-only, same-site cookies where sessions are cookie-backed; allow only explicit production/staging origins; protect state-changing browser requests against CSRF.
- Keep vendor secrets in deployment secret stores. Never send privileged credentials to web code or logs.
- Use least-privilege database and vendor credentials. Migrations, runtime API, worker, and read-only support tooling use separate roles.
- Keep private uploads quarantined until MIME, extension, size, and malware checks pass. A Railway worker runs ClamAV with current signatures; only clean objects receive signed downloads. Maximum support attachment size is 25 MB.
- Record immutable audit events for identity/role, entitlement, refund/dispute, content publication, moderation escalation, export, and Business OS changes.
- Do not send client names, artifact/support content, message bodies, transcripts, contact lists, or private file names to PostHog or Sentry.
- Retain product analytics for 13 months, audit events for at least 24 months, and required financial records for seven years. Customer deletion follows the approved 30-day soft-delete and day-45 active-copy deletion policy except for legally retained records.
- Legal counsel approves final terms, privacy, refund, affiliate, community, HighLevel/white-label, recurring billing, and data-processing disclosures before live payments.

## 15. Failure handling and recovery

Failures are isolated by domain:

- **PostgreSQL unavailable:** enter an explicit read-only/degraded state; do not write into demo data. Preserve safe client drafts locally only when they are clearly labeled unsynced.
- **Clerk or WorkOS unavailable:** retain public cached content; do not bypass authorization. Show provider-specific recovery guidance.
- **Stripe unavailable or webhook delayed:** preserve checkout state, claim each webhook once, expose fulfillment status, and retry from durable receipts.
- **Mux unavailable:** show transcript, summary, action, and resources so the lesson remains useful; retry playback state separately.
- **Resend unavailable:** preserve notification jobs; prioritize account, security, money, coach, and session messages.
- **Circle unavailable:** Academy and support remain available; access synchronization retries independently.
- **HighLevel unavailable:** show Business OS degraded/incident state; Academy remains available.
- **Worker job exhausted:** move to dead-letter state with customer impact, attempt history, next operator action, and replay control.

Neon uses a paid restore window and pooled production connection. Database migrations are backward-compatible and run before dependent application code. Destructive changes require a pre-migration recovery point, staged rehearsal, and explicit rollback path. A restore drill passes before launch and at least quarterly. Targets remain 99.9% monthly application availability, RPO no worse than 24 hours, and RTO no worse than eight hours.

## 16. Acquisition and product analytics

Native Syntholo funnels support Meta/Facebook, Instagram, and later channels without an external funnel builder:

- Self-Paced campaign → native sales page → public Stripe Checkout;
- Guided Pilot campaign → native application → admin decision → private Stripe Checkout;
- readiness campaign → scorecard → secure report → recommended eligible offer;
- Business OS campaign → disclosed interest/offer page → checkout only when operationally enabled.

Syntholo records consent-appropriate first-touch and last-touch source, medium, campaign, content, and landing path. Attribution is carried into the application, checkout metadata, purchase, and account without sending unnecessary PII to PostHog. Marketing consent is separate, unchecked, and never required for transactional delivery.

Core funnel and quality events include landing viewed, scorecard started/completed, report unlocked, Pilot application submitted/approved/declined, checkout started/completed, account claimed, teammate invited/activated, onboarding completed, first lesson started, lesson completed, 18-lesson completion, certificate issued, support thread opened, substantive coach reply, session RSVP/attendance, Operator Club scheduled/active, Business OS onboarding/activation/degradation, refund, dispute, and cancellation.

Initial outcome targets remain:

- 80% of paid accounts begin within seven days;
- 70% of Pilot businesses finish and launch three workflows;
- at least five publishable case studies;
- at least 60% Self-Paced member completion;
- Academy refunds below 8%;
- median substantive coach reply below two business days;
- support workload at or below 20 minutes per active business monthly.

Paid campaign spend scales only after attribution completeness, checkout-to-claim reliability, first-lesson activation, support capacity, and refund quality hold at the approved thresholds.

## 17. Verification and ordered release gates

### Gate 1 — Foundation

- Monorepo structure and independent deployments work.
- Clerk member identity and WorkOS staff identity are separately verified.
- PostgreSQL schema, migrations, scoped repositories, audit, outbox/jobs, and health reporting exist.
- The entitlement authority and its hard invariants pass unit, integration, and property/state-transition tests.
- Cross-account and cross-role authorization tests demonstrate denial, not only happy-path access.

### Gate 2 — Production workflows

- Flows 1–6 pass end to end in staging.
- Admin content, member learning, coach queue, artifact locking, sessions, Circle sync, certificate issuance, and Business OS status use production repositories rather than browser-only state.
- Stripe payment, duplicate webhook, refund, dispute, subscription grace, cancellation, and grant recomputation tests pass.
- File quarantine/scanning, signed downloads, notifications, analytics filtering, audit, and dead-letter operations pass.

### Gate 3 — Complete curriculum

- All 18 required lessons pass automated publication requirements and human review.
- Every required video is ready in Mux and includes captions and transcript.
- Every lesson has summary, action, resources, disclosures, and accessibility approval.
- The production course contains no placeholder content.
- Certificate eligibility and PDF generation pass for the published 18-lesson version.
- Stripe payment creation remains disabled until this gate passes.

### Gate 4 — Staging rehearsal

- Lint, typecheck, unit, integration, contract, E2E, accessibility, responsive, visual, and production-build suites pass in CI.
- Authorization matrix, claim, seat, payment/refund/replay/dispute, learning, completion/certificate, support SLA, review lock, sessions, Circle access, and Business OS checks pass.
- Backup restore, migration rollback, vendor degradation, incident response, data export/deletion, and cancellation drills pass.
- Legal copy, refund disclosure, recurring billing disclosure, privacy, community, affiliate, and white-label disclosures are approved.

### Gate 5 — Controlled production validation

- Production health reports configured integrations without secret exposure.
- One low-value real Academy purchase, webhook, claim, receipt, access grant, refund, and entitlement reversal succeeds.
- Sentry releases/alerts, PostHog filtering, job/cron monitors, database recovery, and on-call notification work.
- Two coaches are trained, staff MFA is enforced, escalation owners are named, and four Pilot calls are scheduled.
- HighLevel snapshot and the seven-check operating runbook pass before Business OS checkout is enabled.
- Observe the controlled release for at least 48 hours with no unresolved critical issue.

### Gate 6 — Public acquisition

- Enable Self-Paced public checkout and Guided Pilot application/approval checkout.
- Enable Operator Club only for eligible Academy accounts with correct scheduled billing.
- Enable Business OS only if its separate readiness gate passes.
- Start measured Meta/Instagram campaigns to native funnels.
- Monitor conversion, fulfillment, claim, activation, support SLA, refund, and incident dashboards daily during launch.

## 18. CI/CD and rollback

Every pull request runs lint, typecheck, domain/unit tests, API contract tests, PostgreSQL integration tests, relevant browser journeys, accessibility checks, and a production build. Protected branches require green checks and review. Production deploys originate only from an immutable reviewed commit.

Deployment order is database-compatible migration, API, worker, then web. API contracts remain backward compatible during a release. Feature exposure is controlled by server-side capability flags or offer state, never client-only switches. Web, API, and worker report the same release identifier to Sentry and health endpoints.

Rollback triggers include any cross-account data exposure, unauthorized staff access, duplicate fulfillment/refund, failed entitlement reversal, payment without claimable access, critical course/support outage, irreversible migration error, or sustained error/latency outside the approved threshold. Rollback disables affected offer/payment capability first, restores the last compatible application version, replays safe jobs by idempotency key, and restores data only when investigation proves it necessary.

## 19. Launch dependencies owned outside application code

- All 18 lesson scripts, video, captions, transcripts, summaries, actions, resources, and disclosures.
- Final legal review and operating company details.
- Stripe products/prices, customer portal, webhook endpoints, tax/refund decisions, and low-value production test method.
- Clerk production identity configuration and Circle OAuth application.
- WorkOS staff directory, staff roles, and mandatory admin MFA.
- Circle Business plan or higher, production spaces/access groups, community rules, and moderation process.
- Two trained coaches, U.S. business calendar, availability rotation, escalation owner, and four Pilot Zoom sessions.
- HighLevel agency/SaaS account, approved reusable snapshot, separate-login handoff, seven-check runbook, and customer export/cancellation process.
- Verified Resend domain, Mux production project, Vercel Blob, Neon projects/restore policy, Railway environments, Vercel project/domain, Sentry alerts, and PostHog consent configuration.
- A GitHub remote with branch protection and CI/CD access; the current local repository has no production remote configured.

## 20. V1 exclusions

V1 excludes automated AI coaching, native workflow building, HighLevel SSO, HighLevel customer-data mirroring, mobile applications, gamification, multilingual content, local currencies, direct member messaging, private one-to-one coaching, custom per-client Business OS builds, public certificate lookup, certificate ID infrastructure, and accreditation claims.

Zoom automation and Business OS synthetic monitoring are deferred only under the explicit triggers in sections 11 and 12. They are known limitations, not indefinite omissions.

## 21. Acceptance summary

The production program is complete only when:

- member/public and staff identity are separate and correctly authorized;
- access is computed only by the central entitlement authority;
- Business OS remains fully isolated from Academy identity and customer data;
- PostgreSQL is the sole Syntholo application system of record;
- all critical writes, money events, jobs, and audit events are idempotent and recoverable;
- the coach SLA and artifact-review lock work at account scope;
- Circle access follows support and Operator Club grants;
- certificates are progress achievements and survive commercial/access changes;
- all 18 complete lessons are published before paid Academy launch;
- flows 1–6, degradation paths, restore, and rollback pass in staging and controlled production;
- acquisition attribution links campaign source to purchase, activation, completion, support quality, and refund outcome without leaking customer content.

No implementation starts from this addendum until the user completes the final document review. The next artifact after approval is a detailed, ordered implementation plan that begins with dual identity and the entitlement authority before downstream feature work.
