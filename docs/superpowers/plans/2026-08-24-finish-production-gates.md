# Finish Production Gates (except Gate 3 content)

> **For agentic workers:** Execute in order. Do not start a later phase until the phase exit criteria pass. Each task is RED → GREEN → focused regression → commit. Do not combine tasks into one commit.

**Status:** Ready to implement from current `main`  
**Date:** 2026-08-24  
**Owner split:** Engineering completes Gates 1, 2, 4, 5, 6. Curriculum owner completes Gate 3 (18 real lessons). Academy Checkout stays disabled until both sides pass.

**Goal:** Take the current Neon-backed academy scaffold to the approved production architecture and launch gates, without producing lesson video/copy. Paid Academy remains server-blocked until Gate 3 reports `canSellAcademy === true`.

**Starting point (do not redo):**

- Monorepo already has `apps/web`, `apps/admin`, `packages/db`, `packages/domain`.
- Student identity is Clerk. Staff identity is Cloudflare Access JWT + `staff` table. Keep that split.
- Stripe test checkout + webhook receipts exist. They do not gate `/learn`.
- Most member/admin screens already persist to Postgres. They are per-`user_id`, not per-account.
- Default branch is `main` at the academy app. Old `codex/production-platform` is archived as tags only.

**Out of scope (Gate 3 — human content):**

- Writing, filming, captioning, or transcribing the 18 required lessons.
- Human accessibility review and curriculum sign-off.
- Replacing placeholder summaries/actions/resources with real teaching copy.

Engineering still builds the **content platform** (Mux signed playback, publish validation, `ContentLaunchReadiness`, certificate PDF job) so Gate 3 is a checklist, not a rewrite.

---

## Non-negotiables

- Admin stays `apps/admin` on a separate origin. Never add Clerk to admin. Never trust an unverified Access header. Every staff mutation re-checks `staff` and writes an audit row.
- Clerk is student-only and US residency. Do not persist student PII in Clerk metadata.
- Access is computed only by `evaluateEntitlements`. UI flags, `ensureEnrollment`, and “signed in” never grant paid capabilities.
- Every customer-owned row has immutable `accountId`. Member DB role is RLS-constrained. Staff/worker roles are separate and audited.
- Production never falls back to Maria / demo fixtures / Mongo. Missing vendor config fails closed.
- Business OS never gates Academy. Certificates are achievements, not entitlements. HighLevel has no API credential in this repo.
- Academy payment creation is disabled until automated + human Gate 3 pass.
- Read `node_modules/next/dist/docs/` before changing App Router code.
- Follow existing visual routes unless a task explicitly changes production behavior.

Detailed task inventories still live in the 2026-08-13 focused plans. This document is the **current-state execution order**. Where those plans put coach/admin inside `apps/web`, implement them in `apps/admin` instead.

| Focused plan | Use for |
|---|---|
| [Foundation](./2026-08-13-production-foundation.md) | API/worker, RLS, actors, outbox, entitlements |
| [Commerce](./2026-08-13-commerce-enrollment.md) | Checkout, claim, seats, Pilot, Club, refund/dispute |
| [Content/learning](./2026-08-13-content-learning-certificates.md) | Platform only: versions, Mux, artifacts, PDF, readiness contract. Skip lesson copy. |
| [Human ops](./2026-08-13-human-operations-community.md) | Support SLA, review lock, sessions, Circle |
| [Business OS](./2026-08-13-business-os-observability.md) | Isolation, seven checks, Resend/PostHog/Sentry |
| [Launch](./2026-08-13-launch-acquisition-hardening.md) | Funnels, CI/CD, restore, Gate 4–6 evidence |

---

## Target topology

```text
syntholo/
├── apps/web          Next.js public + member (Clerk). Calls API. No DB/vendor secrets.
├── apps/admin        Next.js staff (Cloudflare Access). Calls API. No Clerk.
├── apps/api          Fastify. Sole business-write authority.
├── apps/worker       Jobs, notifications, Circle sync, scans, certificate PDF.
├── packages/
│   ├── contracts     Zod request/response/event schemas
│   ├── domain        Pure rules (actors, entitlements, SLA, money, Business OS)
│   ├── database      Drizzle schema, migrations, scoped repos, RLS  (evolve from packages/db)
│   ├── integrations  Stripe, Clerk, Access, Mux, Resend, Blob, Circle, PostHog, Sentry
│   └── testing       Factories, tokens, Postgres helpers
└── infra/            Railway API/worker, test Postgres, gate scripts
```

Four DB roles: migration owner, member (RLS), staff (audited cross-account), worker.

---

## Phase 0 — Stop shipping an open academy

Do this first on `main`. Small, independently shippable, unblocks honest testing of everything after.

### P0.1 Deny unpaid `/learn`

- Remove `ensureEnrollment` from `apps/web/src/app/learn/layout.tsx`.
- Member layout loads `evaluateEntitlements` (even a temporary grant table) and redirects unpaid users to `/pricing` or `/claim`.
- `APP_MODE=production` or any Clerk keys present: `canUseDemoStudent()` is false. Missing Clerk on production fails closed, it does not become Maria.

### P0.2 Support ownership

- `addCustomerReply` / `getThreadMessages` require `thread.user_id` (later `accountId`) = actor. Unknown UUID → 404, not insert.

### P0.3 Admin billing chrome

- `/customers` grant/revoke/refund controls only render for `billing`.
- Commerce nav hidden without `billing`. Instructors/support still must not see purchase emails on that page.

### P0.4 Config truth

- Drop `MONGODB_URI` / `MONGODB_DATABASE` from production required env.
- Production required: `DATABASE_URL`, Clerk pair, Stripe pair, Access audience for admin.
- Mux/Resend/Blob/PostHog become required only when that surface is enabled; they must not keep Mongo as a fake production gate.
- Remove HighLevel API key from env schema (addendum forbids it).

**Exit:** A second Clerk user cannot read/write another student’s support thread. Unsigned visitors never see `/learn` when Clerk is configured. Admin instructors cannot submit refunds and do not see refund controls.

---

## Gate 1 — Foundation

Exit this gate before commerce, Circle, or Business OS checkout work.

### G1.1 Packages and runtimes

- Add `packages/contracts`, `packages/integrations`, `packages/testing`.
- Evolve `packages/db` → `packages/database` with Drizzle **versioned migrations**. Stop `CREATE TABLE IF NOT EXISTS` at boot as the schema source of truth.
- Add `apps/api` (Fastify) and `apps/worker` with health endpoints and a shared `RELEASE_SHA`.
- Root scripts: `dev:api`, `dev:worker`, `test:integration`, `gate:foundation`.
- Next.js apps become API clients. No `DATABASE_URL` or Stripe secret in `apps/web` / `apps/admin` runtime env for production.

### G1.2 Identity actors

Implement canonical actors from [production-program.md](./2026-08-13-production-program.md):

- `MemberActor`: Clerk → membership → `accountId` + `owner | teammate`.
- `StaffActor`: Access JWT (JWKS, `aud`, `iss`, `exp`) → `staff` row → `coach | admin` permissions.
- Distinct Fastify hooks and route prefixes: `/public`, `/member`, `/staff`, `/webhooks`.
- Property tests: Clerk token on staff route = 401; Access JWT on member route = 401.

Keep `apps/admin` as the staff UI. Do not merge it into `apps/web`.

### G1.3 Accounts, seats, RLS

Replace “one `app_users` row is the product” with:

| Table | Role |
|---|---|
| `accounts` | Customer business. Immutable id. |
| `memberships` | Owner + up to two teammates. |
| `invitations` | Pending seats, 7-day expiry, hashed token. |
| `app_users` / `member_identities` | Clerk mapping only. |

- Every customer table gets `account_id NOT NULL`.
- `withAccountScope` sets `SET LOCAL app.account_id` and member role cannot read other accounts.
- Integration tests: user A cannot `SELECT` user B artifacts, support, progress, purchases.
- Migrate existing local rows: one account per current student, owner membership, copy `user_id` rows onto that account.

### G1.4 Entitlement authority

Replace unused `canAccess()` helper with grant records:

- Capabilities: `academy_course`, `support`, `circle_write`, `operator_club`, `business_os`.
- Statuses: `active`, `grace`, `expired`, `refunded`, `revoked`.
- Holds: commerce / seat_changes / business_os_activation.
- `evaluateEntitlements` is pure. Every `/learn/*` and staff grant/revoke goes through it.
- Invariants tested: max 3 seats; Business OS does not grant Academy; certificates are not a grant; refund does not delete progress.

### G1.5 Audit, outbox, jobs

- Domain write + audit row + outbox event in one transaction.
- Worker claims jobs with skip-locked, retries, dead-letter.
- Webhook provider event IDs unique before mutation (keep existing `webhook_receipts`, move them to the API).

### G1.6 Fail closed

- Delete production demo paths: Maria fallback, demo claim, `apps/web/src/lib/demo/**` from runtime (tests may keep fixtures marked `synthetic`).
- Admin `[section]` hardcoded metrics page removed or 404.
- DB/vendor failure shows typed degraded UI; never loads Northstar fixtures.

**Gate 1 exit (must all be true):**

- [ ] `npm run gate:foundation` passes: RLS denial suite, entitlement property suite, dual-identity suite, API/worker health, same release SHA.
- [ ] Web, API, worker, admin build independently.
- [ ] Cross-account tests demonstrate **denial**, not only happy path.

---

## Gate 2 — Production workflows

Start only after Gate 1 exit. Keep `ContentLaunchReadiness.canSellAcademy === false` until the curriculum owner finishes Gate 3.

### G2.1 Commerce and enrollment

From the commerce plan, on the new account/entitlement model:

1. **Offers** — `self_paced`, `guided_pilot`, `operator_club_monthly/annual`, `business_os`. Academy offers return `CURRICULUM_GATE_BLOCKED` until Gate 3.
2. **Scorecard** — persist lead + report; 30-day signed report link; marketing consent separate; later purchase with same verified email attaches the report. No paid grant.
3. **Self-Paced flow** — Stripe Checkout → signed webhook claimed once → purchase + 3 seat reservations + 12-month support/community grants + enrollment + hashed 7-day claim token + receipt job + audit. Code path exists and is tested in staging; **public enablement waits for Gate 6**.
4. **Claim** — Clerk magic link / Google / Microsoft; verified email must match Stripe email; token single-use. Mismatch does not enroll the wrong account. Reminders at 1h / 24h / 72h via worker.
5. **Onboarding** — resumable: business profile, scorecard attach, three priorities, teammate invites, delivery schedule, dashboard. Target median < 8 minutes.
6. **Seats** — owner is seat 1; invites reserve seats; resend/revoke/replace; ownership transfer requires recent auth.
7. **Guided Pilot** — application → admin decision (audited) → cohort + capacity → expiring private $750 Checkout. Same fulfillment as Self-Paced plus cohort enrollment.
8. **Operator Club** — only if Academy grant exists. If support window still active, Stripe billing starts at expiry. Failure → 7-day grace; day 8 drops Club-derived support/Circle only.
9. **Refund / dispute / cancel** — recompute **only** grants sourced from that transaction. Preserve account, progress, certificates, financials, audit. Open dispute sets holds. Academy 7-day unconditional refund policy is the same string in pricing, Checkout, Pilot email, and terms.
10. **Admin commerce** — purchases, refunds, manual grants, coupons. Coaches cannot access it.

### G2.2 Learning platform (not curriculum copy)

Do the engineering from the content plan that Gate 2 and Gate 3 both need:

- Account-scoped artifacts (5 outputs) with optimistic concurrency and conflict comparison UI.
- Workflow records on the account; completion rule (18 lessons + 5 finals + 3 `live`) lives in domain, not the page.
- Lesson progress per membership; resume position; transcript path counts as complete (video watch not required).
- Mux adapter: signed playback JWT, ready-state, captions/transcript attachment. Lesson player uses signed Mux, not a raw YouTube URL, when an asset exists.
- Admin publish validation: refuse publish without title, summary, ready Mux asset, captions, transcript, duration, action, resources, accessibility flag, required disclosure. **Empty curriculum is valid; placeholder-marked lessons are not “ready.”**
- `ContentLaunchReadiness` report: `requiredLessons = 18`, `readyLessons`, hashes, `automatedPassedAt`, `humanApprovedAt`, `canSellAcademy`.
- Certificate: on first eligibility, immutable completion fact, worker PDF (member, business, course version, date), private Blob, member download. Survives refund. No public lookup.
- Seeded placeholder lessons may remain for local demo **only** when `APP_MODE != production`. Production course starts unpublished until Gate 3.

### G2.3 Human ops and Circle

- Support threads belong to `accountId`. Owner + teammates share history.
- First customer message starts 2 U.S. business-day SLA (America/New_York calendar) and round-robin assigns an available coach.
- Warn at 8 business hours remaining; pause in `waiting_on_customer`; record breach/satisfaction.
- Artifact review lock: one `submitted | in_review` per account (DB constraint).
- Attachments: PDF/DOCX/XLSX/CSV/PNG/JPG ≤ 25 MB; quarantine; ClamAV on worker; signed download only when clean.
- Sessions: Pilot 4 weekly from cohort start; office hours Americas + Europe/Asia. RSVP, capacity, waitlist, ICS, 24h/1h reminders, join button 15 minutes before. Zoom URL is **manual** (v1).
- **Replace in-app community as system of record.** Postgres posts/comments/reactions are not production community. Circle Business: Clerk OAuth SSO; worker syncs entitlement groups (write during support window or Club; otherwise read-only). Failed Circle sync does not block Academy/support.
- Coach UI in `apps/admin` with `support` capability: queue, SLA, account context. No billing, refunds, staff admin, or unrestricted export.

### G2.4 Business OS (status only)

- Capability and state machine independent of Academy.
- Member sees onboarding/provisioning status + external HighLevel login hyperlink.
- Admin: questionnaire, 5-day SLA clock (pauses when blocked), seven named checks with evidence **references** (no customer data), monthly re-verify, `degraded` + incident + customer notice without touching Academy.
- Checkout remains disabled until HighLevel snapshot + runbook evidence is attached (external). No HighLevel API keys in env.

### G2.5 Notifications and observability plumbing

- Resend only via worker jobs: scorecard report, receipt, claim, invites, security, session, coach reply, payment failure, support expiry, provisioning, cancellation warnings. Community = weekly digest. Security/payment/account mail is mandatory.
- PostHog US: consent-aware; replay off; allowlisted events; no names, emails, message bodies, transcripts, file names.
- Sentry on web/api/worker with PII scrub and `RELEASE_SHA`.

**Gate 2 exit:**

- [ ] Flows 1–6 pass in **staging** against Stripe test + Clerk + Access (Academy Checkout still not public).
- [ ] Duplicate webhook, refund, dispute, Club grace, review-lock race, SLA pause, certificate-after-refund, Circle retry, scan quarantine, dead-letter all have automated tests.
- [ ] No completed production route reads demo fixtures.
- [ ] `canSellAcademy` is still false until Gate 3.

---

## Gate 3 — Curriculum (owner, not this plan)

Engineering delivers the readiness command. Curriculum owner supplies 18 published lessons that pass it.

```bash
npm run gate:content
```

Must print: 18 required published lessons, Mux ready, captions, transcript, summary, action, resources, disclosures, accessibility approval, no placeholder markers, human `approvedAt`.

Until that report exists, `evaluateOfferAvailability(self_paced | guided_pilot)` stays blocked. Do not “temporarily” enable payments to test launch. Use Stripe test mode in staging with a **staging override flag** that is impossible to set in production (`NODE_ENV=production` rejects it).

---

## Gate 4 — Staging rehearsal

Start when Gate 2 is green. Gate 3 may still be in progress; rehearsal uses the staging override for one synthetic Academy SKU, never production keys.

### G4.1 Quality matrix in CI

GitHub Actions on `main`: lint, typecheck, unit, contract, Postgres integration, Playwright journeys, axe, production builds for web/admin/api/worker. Branch protection: green checks + review.

### G4.2 Security and privacy

- Rate-limit scorecard, applications, claim, invites, support writes, checkout.
- CSRF, CORS allowlist, secure cookies, explicit origins.
- Recent-auth step-up: ownership transfer, seat replace, refund, role change, export, destructive admin.
- Soft-delete 30 days / hard-delete active copies by day 45 except legal retain (financial 7y, audit 24m, analytics 13m).
- Export/deletion endpoints with audit.

### G4.3 Native funnels (code)

- First/last-touch UTM on landing → application/checkout/account. Marketing consent unchecked and not required for transaction.
- Public pages: marketing, scorecard + 30-day report, Pilot application, pricing, legal drafts swapped for **counsel-approved** copy before Gate 6 (legal is external; code has slots and a `legalApprovedAt` flag).
- Waitlist allowed before paid launch.

### G4.4 Deploy and recovery

- Vercel: `apps/web` + `apps/admin` (admin not publicly routable; Cloudflare Tunnel + Access).
- Railway: API, worker, cron. Deploy order: migration → API → worker → web.
- Neon: separate staging/production US projects, pooling, restore window.
- Preview deploys: synthetic data only; no production secrets/PII.
- Documented drills with recorded evidence: backup restore, migration rollback, Clerk/Stripe/Mux/Resend/Circle/Postgres degradation (typed, no demo fallback), incident response.
- Targets: 99.9% monthly, RPO 24h, RTO 8h.

**Gate 4 exit:**

- [ ] `npm run gate:staging` green.
- [ ] Authorization matrix doc matches tests (member/coach/admin × resource).
- [ ] Restore and rollback drills dated and stored.
- [ ] Legal flag may still be `blocked`; Gate 6 cannot pass without it.

---

## Gate 5 — Controlled production validation

No public ads. No Self-Paced on the marketing site.

1. Production health reports configured integrations **without secrets**.
2. Staff MFA is an Access policy. Two coaches in `staff`, escalation owner named.
3. Four Pilot Zoom sessions exist as session rows (manual join URLs).
4. Circle production spaces + access groups exist; SSO works for one test member.
5. One **low-value real** Academy purchase (after Gate 3, or a production-only $1 SKU that is not publicly linked — prefer waiting for Gate 3). Webhook → claim → receipt → grant → refund → grant reversal. Progress and certificate (if any) remain.
6. Sentry alerts, PostHog filtering, job/cron monitors, on-call notification fire on a staged error.
7. Observe 48 hours, no unresolved critical.

If Gate 3 is not done, **stop after deploying dark** (Checkout flagged off, health green, Access MFA, monitors). Do not take a real Academy payment.

**Gate 5 exit:**

- [ ] Dark production is up and monitored, or the low-value purchase loop passed if Gate 3 is already signed.
- [ ] Rollback switch (disable offer) is tested.

---

## Gate 6 — Public acquisition

Requires Gate 3 **and** Gate 5.

- Enable Self-Paced public Checkout and Guided Pilot application → private Checkout.
- Enable Operator Club only for accounts with Academy grant; scheduled billing at support expiry.
- Enable Business OS only if HighLevel snapshot + seven-check runbook evidence is attached.
- Capped Meta/Instagram to native funnels. Daily review: conversion, fulfillment, claim, activation, support SLA, refund, incidents.
- Scale spend only after those hold.

**Gate 6 exit:** public offers match entitlement rules; `gate:production` shows Gates 1–6 `PASS`.

---

## External dependencies (not code)

Track as `blocked` in `npm run gate:production` until evidence exists. Do not fake them in code.

| Dependency | Needed by |
|---|---|
| 18 complete lessons + human sign-off | Gate 3 / 6 |
| Legal counsel: terms, privacy, refund, affiliate, community, HighLevel, recurring billing, DPA | Gate 4 / 6 |
| Stripe live products, portal, tax, webhook, low-value test method | Gate 5 |
| Clerk production + Circle OAuth app | Gate 5 |
| Cloudflare Access directory, MFA, tunnel to admin origin | Gate 5 |
| Circle Business plan, spaces, groups, rules | Gate 2 staging / Gate 5 prod |
| Two trained coaches, US calendar, rotation | Gate 5 |
| Four Pilot Zoom meetings | Gate 5 |
| HighLevel agency, snapshot, seven-check runbook | Business OS enable |
| Resend domain, Mux prod, Blob, Neon restore policy, Railway, Vercel, Sentry, PostHog consent | Gate 4 / 5 |
| GitHub branch protection | Gate 4 |

---

## Suggested implementation slices (PRs)

Keep PRs vertical and reviewable. Approximate order:

1. P0 security (enroll, IDOR, admin chrome, env)
2. `packages/contracts` + `packages/database` migrations bootstrap (no behavior change)
3. `accounts` + memberships + RLS + backfill
4. Entitlement grants + stop layout auto-enroll for real (if P0 used a shim, replace it)
5. `apps/api` + `apps/worker` skeleton; move Stripe webhook to API
6. Claim tokens + email match + seats/invites
7. Onboarding + scorecard report links
8. Pilot application + admin decision + private Checkout
9. Operator Club + refund/dispute recompute
10. Artifact concurrency + review lock + account-shared support + SLA
11. Mux adapter + publish validator + `gate:content` (no lesson copy)
12. Certificate PDF worker
13. Sessions reminders/join window
14. Circle SSO + drop in-app community from production mode
15. Business OS state machine + seven checks (no HL API)
16. Resend/PostHog/Sentry allowlists
17. CI, Railway, Vercel, restore docs, `gate:*` commands
18. Acquisition attribution + waitlist; Checkout still gated

---

## Verification commands

```bash
npm ci
npm run lint --workspaces --if-present
npm run typecheck --workspaces --if-present
npm run test --workspaces --if-present
npm run test:integration
npm run build --workspaces --if-present
npm run test:e2e
npm run gate:foundation    # after Gate 1
npm run gate:workflows     # after Gate 2
npm run gate:content       # curriculum owner; engineering keeps it honest
npm run gate:staging       # Gate 4
npm run gate:production    # prints PASS/BLOCKED per gate; never enables pay while 3 is BLOCKED
```

---

## Definition of done for this plan

The product is **engineering-ready for production** when Gates 1, 2, 4 are `PASS`, Gate 5 is at least dark-prod `PASS`, and Gate 6 is `BLOCKED` only on Gate 3 + legal + HighLevel evidence.

It is **fully launch-ready** only when the curriculum owner also passes Gate 3 and ops attach the external evidence. This plan does not pretend Gate 6 can complete without that.
