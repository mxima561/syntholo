# Syntholo

Syntholo is a polished end-to-end platform for the **AI Operating System Academy**: a practical, human-supported program that helps service-business owners set safe AI rules, launch three workflows, and leave with a 90-day plan.

## What is included

- Public homepage, pricing, 20-question readiness scorecard, report, and account claim
- Real student authentication via Clerk (`/signin`, `/signout`) mapped to internal `app_users.id`
- Separate admin app on `:3001` behind Cloudflare Access; authorization is the `staff` table (no auto-provisioning)
- **Stripe test-mode checkout** for all three offers, webhook-driven fulfillment (idempotent), subscription cancellation revoking access, and enrollment granting
- Member command center, six-stage/18-lesson course (served from the database), lesson video playback (YouTube/Vimeo/MP4), and persistent lesson progress
- **Persistent community**: DB-backed posts, spaces, and per-member likes
- **Persistent human support**: student inbox with coach threads, admin Support queue with coach replies, auto-created welcome thread per student
- 30-day implementation plan, five required business outputs, and three-workflow registry
- Working admin panel: live overview metrics, full course/lesson CRUD with draft/publish workflow, Students tab with progress + role management
- **Neon Postgres** as the system of record (auto-migrating schema + curriculum seed on startup)

## Run locally

Requirements: Node.js 20.9 or newer.

1. `npm install` from the repo root (npm workspaces: `apps/web`, `apps/admin`, `packages/db`, `packages/domain`)
2. Set `DATABASE_URL` in the root `.env` (a Neon connection string, or any Postgres URL)
3. For student sign-in: create a US [Clerk](https://dashboard.clerk.com) application, then set `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. Do not store student PII in Clerk metadata.
4. For payments: set `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (test mode keys) and add a webhook endpoint at `{APP_URL}/api/webhooks/stripe` for `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`
5. Seed staff with `STAFF_BOOTSTRAP_EMAILS` and `npm run db:seed-staff`. Local admin: `ADMIN_DEV_BYPASS_EMAIL` (never in production, and only when `CF_ACCESS_AUD` is unset).
6. `npm run dev` (student app in `apps/web`). `npm run dev:admin` starts the admin app on port 3001.

The database schema is created and the curriculum seeded automatically at server startup.

Useful entry points:

- `/` — acquisition site
- `/scorecard` — readiness assessment
- `/pricing` — offers and disclosures
- `/learn` — member workspace
- `http://localhost:3001` — admin console (Cloudflare Access in production)
- `/api/health` — runtime configuration state

## Quality checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## Production launch

The current repository is a tested product demo and integration scaffold, not the approved production backend. Do not enable live payments or treat `APP_MODE=production` as production readiness. The backend-first production architecture, launch gates, and migration boundaries are defined in the [Production Launch PRD Addendum](docs/superpowers/specs/2026-08-12-production-launch-design.md). The existing `.env.example` and [demo runbook](docs/operations/demo-and-production.md) describe the current scaffold and will be replaced during implementation.

The product specification is in [docs/product/prd.md](docs/product/prd.md), production architecture is in the [Production Launch PRD Addendum](docs/superpowers/specs/2026-08-12-production-launch-design.md), visual rules are in [design.md](design.md), and the original demo implementation plan is in [docs/superpowers/plans/2026-08-11-syntholo-platform.md](docs/superpowers/plans/2026-08-11-syntholo-platform.md).
