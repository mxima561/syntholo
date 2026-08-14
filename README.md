# Syntholo

Syntholo is a polished end-to-end platform for the **AI Operating System Academy**: a practical, human-supported program that helps service-business owners set safe AI rules, launch three workflows, and leave with a 90-day plan.

## What is included

- Public homepage, pricing, 20-question readiness scorecard, report, checkout preview, and account claim
- Member command center, six-stage/18-lesson course, lesson player, transcripts, and templates
- 30-day implementation plan, five required business outputs, and three-workflow registry
- Shared human coach inbox, business-day SLA states, live office hours, recordings, and owner community
- Disclosed optional Business OS offer, onboarding questionnaire, five-business-day provisioning, and seven activation checks
- Administrator overview, course editor, support/community/customer/commerce/analytics surfaces, and provisioning board
- Backend-first PostgreSQL, separate member/staff identity, durable jobs/audit, centralized entitlements, and public PostHog analytics

## Run locally

Requirements: Node.js 22.22.2 and npm 10.9.7.

```bash
npm install
cp .env.example .env.local
export RELEASE_SHA="$(git rev-parse HEAD)"
npm run dev:web
```

Open [http://localhost:3000](http://localhost:3000). Demo mode uses the deterministic Northstar Advisory workspace and never contacts vendors.

Useful entry points:

- `/` — acquisition site
- `/scorecard` — readiness assessment
- `/pricing` — offers and disclosures
- `/learn` — Maria Chen’s member workspace
- `/admin` — operations console
- `/api/health` — web service/release health

## Quality checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run gate:foundation
```

## Production launch

`APP_MODE=production` is not a launch approval. The SHA-bound engineering gate, independent migration/API/worker/cron processes, image evidence, deployed proxy evidence, provider settings, protected branch, and operational owners are described in the [foundation deployment runbook](docs/operations/foundation-deploy.md). The [demo/production note](docs/operations/demo-and-production.md) defines the strict web secret boundary.

The product specification is in [docs/product/prd.md](docs/product/prd.md), production architecture is in the [Production Launch PRD Addendum](docs/superpowers/specs/2026-08-12-production-launch-design.md), visual rules are in [design.md](design.md), and the original demo implementation plan is in [docs/superpowers/plans/2026-08-11-syntholo-platform.md](docs/superpowers/plans/2026-08-11-syntholo-platform.md).
