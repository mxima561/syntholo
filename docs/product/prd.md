# Syntholo AI Operating System Academy — Product Requirements Document

**Version:** 1.1
**Status:** Approved for implementation  
**Market:** English-speaking global, USD pricing  
**Target:** Dual-path production launch after the ordered release gates pass

> **Production architecture addendum:** [2026-08-12 Production Launch PRD Addendum](../superpowers/specs/2026-08-12-production-launch-design.md). The addendum supersedes this document where it changes customer identity, staff identity, PostgreSQL architecture, Circle community, certificates, entitlement boundaries, production flows, and launch gates.

## 1. Problem and outcomes

Professional-services owners face fragmented AI advice, tool confusion, data-safety concerns, and no implementation path. Syntholo combines a structured 30-day course, shared business outputs, live human guidance, a professional community, and an optional configured HighLevel operating system.

### Launch outcomes

- 10–15 paid pilot businesses.
- 80% begin within seven days.
- 70% of pilot businesses finish and launch three workflows.
- Five publishable case studies.
- 50 self-paced purchases after pilot refinement.
- 60% self-paced completion, refunds below 8%, and median coach response under two business days.
- Support workload at or below 20 minutes per active business monthly.

### Personas

Prospective owner, customer owner, customer teammate, pilot member, self-paced learner, Operator Club member, Business OS subscriber, coach, and administrator.

### Non-goals

No AI coach, native workflow builder, mobile app, public certificate lookup, certificate ID infrastructure, accreditation claims, gamification, direct messaging, multilingual interface, local currencies, one-to-one coaching, or deep HighLevel integration in v1.

## 2. Offers and entitlements

| Offer | Price | Seats | Learning | Human layer |
|---|---:|---:|---|---|
| Readiness Scorecard | Free | 1 | Diagnostic report | None |
| Guided Pilot | $750 once | 3 | Lifetime course | Four weekly calls + 12 months support/community |
| Self-Paced | $399 once | 3 | Lifetime course | 12 months support/community + monthly office hours |
| Operator Club | $59/mo or $590/yr | 3 | Purchased courses | Active support, community, playbooks, office hours |
| Business OS | $999 + $199/mo | 3 HighLevel users | None unless separately purchased | Configured HighLevel service with separate login |

Course refunds are unconditional for seven days, subject to mandatory law. Operator Club cancels at term end. Business OS onboarding is refundable until provisioning starts. Failed subscriptions receive seven days of grace; day eight restricts paid benefits without deleting data.

Operator Club is available only to existing Academy accounts. Its initial interval begins at the later of the exact included-support end and trusted fulfillment time, so early selection waits for expiry and later re-entry is not backdated. Business OS is independent: only its recurring subscription funds Business OS access, while the setup fee is a zero-grant receipt; neither grants nor gates Academy or Operator Club access.

Entitlements are `course`, `support`, `community_write`, `operator_club`, and `business_os`; statuses are `active`, `grace`, `expired`, `refunded`, and `revoked`.

## 3. Acquisition and account process

### Readiness scorecard

The assessment has 20 deterministic 0–4 questions across Strategy, Safety, Growth, Client Delivery, and Operations. Equal-weight scores convert to 0–100: Foundation 0–24, Exploring 25–49, Building 50–74, and Scaling 75–100.

After completion, show the overall score and band. Require first name, work email, business name, and country to unlock the five-dimension report, priority gaps, first recommended workflow, and three next actions. Marketing consent is separate and unchecked. Reports use secure 30-day links. A later purchase with the same verified email attaches the report as the readiness baseline.

### Checkout and claim

Checkout occurs before account creation. Stripe success creates a pending purchase, enrollment, entitlements, and a seven-day claim token through a verified, idempotent webhook. The buyer claims access through Clerk magic link, Google, or Microsoft. The verified Clerk and Stripe emails must match. Reminders send after one hour, 24 hours, and 72 hours.

Each customer identity belongs to one customer business. The buyer becomes `customer_owner`; two pending or active teammate invitations consume the remaining seats. Invitations expire in seven days. Owners can revoke, resend, replace teammates, and transfer ownership after reauthentication.

### Onboarding

Collect business name, optional website, category, country, timezone, team-size band, owner role, primary goal, current CRM, scheduling, and email tools. Attach or complete the scorecard, select three priorities, invite teammates, confirm delivery schedule, and land on the dashboard. The flow is resumable and targets a median under eight minutes.

## 4. Learning process

### Curriculum

1. Diagnose: operating-system model, journey mapping, opportunity scoring.
2. Rules: tools, data handling, team AI policy.
3. Growth: lead capture, qualification/routing, booking/follow-up.
4. Client: proposals, onboarding, recurring communication.
5. Management: reporting, meetings/tasks, business knowledge.
6. Launch: testing, team enablement, measurement and roadmap.

The 18 required lessons run 5–12 minutes and include signed video, captions, transcript, summary, action, and resources. Video watching is not mandatory for completion because transcripts are equivalent access.

### Progress and outputs

Each learner tracks lesson status and resume position independently. The business shares five versioned outputs: readiness/opportunity map, AI policy, three-workflow launch portfolio, enablement checklist, and 90-day roadmap.

Completion requires all 18 lessons, all five outputs, and three workflow records marked `live`. Each workflow stores its problem, trigger, owner, tools, steps, human review point, data-safety notes, baseline, target, test status, and launch date. New course content never revokes a previous completion.

Each member receives an unaccredited PDF certificate after completing the 18 required published lessons for the enrolled course version. Certificate issuance is a progress achievement, not an entitlement. It is independent of purchase tier and support status and is not revoked by a refund, dispute, seat reassignment, or support expiry. V1 has no public lookup, certificate ID system, or accreditation claim.

Shared outputs autosave and use optimistic version checks. A conflicting edit must show comparison rather than silently overwrite. Members may request human feedback on one artifact at a time.

### Next best step

Dashboard precedence is: access/payment blocker, support response waiting on customer, session within 48 hours, next required lesson, incomplete artifact, received feedback, then optional community or commercial recommendation.

## 5. Human support, sessions, and community

All three teammates share a support inbox. Questions route round-robin to available coaches. Thread states are `new`, `assigned`, `waiting_on_coach`, `waiting_on_customer`, `resolved`, and `closed`. The two-business-day SLA measures substantive response time on Syntholo's U.S. operating calendar, pauses while waiting on the customer, and warns operations eight business hours before breach.

Private support attachments allow PDF, DOCX, XLSX, CSV, PNG, and JPG up to 25 MB after malware checks.

Pilot cohorts receive one Zoom session weekly for four weeks. Self-paced and Operator Club members receive two repeated monthly office hours at Americas-friendly and Europe/Asia-friendly times. RSVP provides timezone conversion, capacity/waitlist, calendar file, 24-hour and one-hour reminders, and a join button 15 minutes before start. Edited teaching/Q&A recordings publish within two business days.

Community spaces are Start Here, Wins, Growth, Client, Management, Tool Questions, Announcements, and private cohorts. Members use real name, role, and business. Content publishes immediately and can be reported, hidden, restored, locked, or removed. Expired support becomes read-only. Direct messaging and community file uploads are excluded.

Circle is the community system of record. Clerk provides OAuth 2.0 SSO, and Syntholo synchronizes entitlement-driven Circle access groups without mirroring posts or comments into the application database.

## 6. Operator Club and Business OS

Membership prompts appear 30 days, seven days, and on the support-expiration date, while clearly stating that lifetime course access continues.

Business OS includes one branded HighLevel account, three users, one pipeline, one calendar, lead form, email/SMS response templates, lead routing, appointment follow-up, client onboarding, basic dashboard, one web-chat or appointment AI assistant, one consented CSV import up to 2,500 contacts, kickoff, handoff, and one revision round. Usage-based telecom, messaging, and AI charges are separate and disclosed.

Checkout charges $999 and starts $199/month. The five-business-day provisioning SLA begins after the complete questionnaire. States are `pending_onboarding`, `provisioning`, `active`, `paused`, and `canceled`. External verification or missing customer access pauses the SLA. Activation requires test lead capture, routing, booking, messages, onboarding, AI escalation, and dashboard activity.

Cancellation starts a 30-day export/reactivation window, with notices on days 0, 14, 27, and 29. Academy access is independent of HighLevel status.

After activation, an operator manually re-runs the seven activation checks monthly and after material HighLevel changes or customer reports. A failure sets `degraded`, opens an incident, and notifies the customer. Automate monitoring at 25 active accounts, two customer-discovered degradations within 90 days, or eight operator hours per month, whichever happens first.

## 7. Administration and content operations

The structured editor supports course, stage, lesson, drag ordering, draft/preview/scheduled/published/archived states, reusable video/text/callout/checklist/download/recommendation/disclosure/assignment blocks, release week, and version history.

A video lesson cannot publish without title, summary, ready Mux asset, captions, transcript, duration, action, accessibility review, and any required commercial disclosure. Published content with progress can only be archived.

Administrators manage customers, seats, purchases, refunds, manual entitlements, coupons, cohorts, sessions, coaches, support, community, recommendations, analytics, and Business OS provisioning. Coaches cannot access billing administration. Refunds, entitlements, roles, publication, moderation, and software activation create audit events.

## 8. Notifications

Send scorecard reports, receipts, account claims, invites, security alerts, session confirmations/reminders, coach replies, payment failures, support expiration, provisioning changes, and cancellation/export warnings immediately. Send ordinary community activity as a weekly local-time digest. Educational reminders and digests are optional; security, payment, account, and policy notices are mandatory.

## 9. Technical architecture

- One TypeScript monorepo with independently deployable Next.js web, Fastify API, and worker/cron applications.
- Next.js App Router web on Vercel.
- API, worker, and cron services on Railway.
- Neon PostgreSQL in a U.S. primary region with pooled connections and tested point-in-time recovery.
- Clerk for customer owners and teammates, including magic links, social sign-in, and Circle OAuth SSO.
- Cloudflare Access for coach/admin identity and RBAC, with mandatory MFA for administrators.
- A central entitlement authority for all access decisions.
- Mux signed video.
- Stripe Checkout/Billing.
- Zoom live sessions.
- Resend transactional email.
- Vercel Private Blob for templates, artifacts, and attachments.
- Circle Business or higher for community and entitlement-driven access groups.
- PostHog U.S. Cloud with session replay disabled and no PII or content properties.
- HighLevel SaaS Mode and snapshots with separate login.
- Sentry and Vercel observability.

Every customer-owned PostgreSQL row carries an immutable `accountId`. Member-facing database access is protected by scoped repositories and PostgreSQL row-level security; staff and worker roles remain separate and audited. Webhook receipts store provider event IDs before mutation. Vendor failures must not block unrelated product areas or fall back to demo data.

## 10. Quality and release gates

- WCAG 2.1 AA, keyboard-complete, reduced motion, captions, transcripts, and 44px touch targets.
- p75 LCP below 2.5s, INP below 200ms, CLS below 0.1, internal API p95 below 500ms excluding vendors.
- 99.9% monthly application target; RPO 24 hours, RTO eight hours.
- U.S. primary data region; consent-gated analytics where required; 13-month analytics retention, 24-month audit retention, financial records seven years.
- Soft-delete customer data for 30 days and hard-delete active copies by day 45, except legally retained records.

Internal alpha must pass cross-account authorization, dual-identity separation, payment/refund/dispute/entitlement replay, content publication, learning, certificate, support, session, Circle, and provisioning journeys. Paid launch requires all 18 accessible lessons to be complete and published, four scheduled Pilot calls, two trained coaches, approved legal copy, and incident/support runbooks. Business OS checkout additionally requires the approved HighLevel snapshot and seven-check operating process.
