# Syntholo

Syntholo is a polished end-to-end platform for the **AI Operating System Academy**: a practical, human-supported program that helps service-business owners set safe AI rules, launch three workflows, and leave with a 90-day plan.

## What is included

- Public homepage, pricing, 20-question readiness scorecard, report, checkout preview, and account claim
- Member command center, six-stage/18-lesson course, lesson player, transcripts, and templates
- 30-day implementation plan, five required business outputs, and three-workflow registry
- Shared human coach inbox, business-day SLA states, live office hours, recordings, and owner community
- Disclosed optional Business OS offer, onboarding questionnaire, five-business-day provisioning, and seven activation checks
- Administrator overview, course editor, support/community/customer/commerce/analytics surfaces, and provisioning board
- Demo-safe adapters for MongoDB Atlas, WorkOS, Stripe, Mux, Resend, PostHog, Vercel Blob, and HighLevel

## Run locally

Requirements: Node.js 20.9 or newer.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Demo mode uses the deterministic Northstar Advisory workspace and never contacts vendors.

Useful entry points:

- `/` — acquisition site
- `/scorecard` — readiness assessment
- `/pricing` — offers and disclosures
- `/learn` — Maria Chen’s member workspace
- `/admin` — operations console
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

Set `APP_MODE=production`, configure every required value in `.env.example`, register the Stripe webhook at `/api/webhooks/stripe`, and follow [docs/operations/demo-and-production.md](docs/operations/demo-and-production.md). WorkOS authorization and live Stripe Checkout should be connected at deployment; this repository intentionally keeps all local journeys usable without credentials.

The product specification is in [docs/product/prd.md](docs/product/prd.md), visual rules are in [design.md](design.md), and the implementation plan is in [docs/superpowers/plans/2026-08-11-syntholo-platform.md](docs/superpowers/plans/2026-08-11-syntholo-platform.md).
