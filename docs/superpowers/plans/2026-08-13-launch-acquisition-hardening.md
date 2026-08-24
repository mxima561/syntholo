# Launch, Acquisition, and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden and deploy the integrated platform, prove authorization/recovery/rollback, complete native consent-aware acquisition funnels, synchronize customer-facing policy copy, and release paid offers through controlled production validation before scaling Meta/Instagram traffic.

**Architecture:** Vercel deploys the web app; Railway deploys API, worker, and cron; Neon provides separate staging/production PostgreSQL projects. GitHub Actions runs the full quality matrix, backward-compatible migrations precede services, server-side capability flags control offers, and a machine-readable gate command prevents release when any technical, curriculum, legal, staffing, vendor, or controlled-validation dependency is blocked.

**Tech Stack:** GitHub Actions, Vercel, Railway, Neon, Clerk, Cloudflare Access, Stripe, Mux, Resend, Vercel Blob, Circle, PostHog, Sentry, Next.js, Fastify, PostgreSQL, Vitest, Playwright, axe-core, Autocannon, and provider CLIs/APIs.

## Global Constraints

- This plan starts after all other focused plan test suites pass on the integration branch.
- Do not enable paid Academy Checkout until Gate 3 has a current automated report hash and admin human approval.
- Do not enable Business OS Checkout until its separate operational readiness and seven-check runbook dependencies pass.
- Customer-facing seven-day Academy refund language must match the implemented policy in sales pages, Pilot email, Checkout, and terms; legal approval is a hard launch dependency.
- Preview deployments receive synthetic data only and no production credentials or copied production PII.
- Staging and production use distinct vendor projects, keys, webhook endpoints, databases, storage prefixes, analytics, Circle groups, email controls, and domains.
- Deploy order is compatible migration → API → worker/cron → web. Schema changes use expand/migrate/contract and retain rollback compatibility for at least one release.
- Any cross-account exposure, unauthorized staff access, duplicate fulfillment/refund, payment without claimable access, failed grant reversal, critical course/support outage, or irreversible migration error disables the affected capability and triggers rollback.
- Target RPO is ≤24 hours, RTO ≤8 hours, and availability target is 99.9% monthly.
- Public acquisition begins with capped spend and daily review; it scales only after attribution, claim, activation, support, and refund thresholds hold.
- Legal counsel, vendor account owners, curriculum owner, coaches, and operations owners must supply evidence; code cannot mark their gates complete automatically.

## Planned File Map

- `apps/web/src/app/{scorecard,pilot,pricing,terms,privacy}/**` — native funnels and policy surfaces.
- `apps/web/src/lib/analytics/**` — first/last touch and consent integration.
- `apps/web/tests/e2e/{acquisition,authorization,recovery,release}.spec.ts` — integrated journeys.
- `apps/api/src/plugins/{cors,csrf,rate-limit,security-headers}.ts` — HTTP controls.
- `apps/api/src/modules/privacy/**` — export/deletion/retention.
- `packages/domain/src/privacy/**` — retention/deletion rules.
- `.github/workflows/{ci,deploy-staging,deploy-production,restore-drill}.yml` — protected delivery.
- `infra/{vercel,railway,neon,scripts}/**` — runtime/deploy/gate assets.
- `docs/operations/{launch,rollback,restore,incident,privacy,acquisition}.md` — operator execution.
- `docs/architecture/authorization-matrix.md` — allow/deny contract.

---

### Task 1: Complete native campaign funnels, consent, and first/last-touch attribution

**Files:**
- Create: `apps/web/src/lib/analytics/{attribution,consent}.ts`
- Create: `apps/web/src/lib/analytics/{attribution,consent}.test.ts`
- Modify: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/academy/page.tsx`
- Create: `apps/web/src/app/pilot/page.tsx`
- Modify: `apps/web/src/app/scorecard/page.tsx`
- Create: `apps/web/src/app/scorecard/report/page.tsx`
- Modify: `apps/web/src/app/pricing/page.tsx`
- Modify: `apps/web/src/app/pilot/apply/page.tsx`
- Create: `apps/web/src/app/business-os/page.tsx`
- Create: `apps/web/tests/e2e/acquisition.spec.ts`

**Interfaces:**
- Produces first-touch once and last-touch per qualifying landing for `source`, `medium`, `campaign`, `content`, and landing path.
- Marketing consent is separate, unchecked, revocable, and not required for scorecard/application/Checkout transactional fulfillment.
- Attribution IDs flow to server lead/application/Checkout/account records; PostHog receives allowlisted campaign dimensions and pseudonymous IDs only.

- [ ] **Step 1: Write attribution/consent RED tests**

Cover first visit, second campaign, direct return, malformed/oversized UTM, no consent, consent grant/revoke, scorecard submission, Pilot application, Checkout metadata, and no email/name in analytics calls.

```ts
it("preserves first touch and updates last touch", () => {
  const first = captureAttribution(null, landing("meta", "pilot-a"), now);
  const second = captureAttribution(first, landing("instagram", "academy-b"), hour(1));
  expect(second.firstTouch.source).toBe("meta");
  expect(second.lastTouch.source).toBe("instagram");
});

it("does not make marketing consent a transactional requirement", () => {
  expect(canSubmitCheckout({ marketingConsent: false, termsAccepted: true })).toBe(true);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/web -- attribution consent && npm run test:e2e -w @syntholo/web -- acquisition.spec.ts`

Expected: current marketing pages do not persist the full approved attribution chain.

- [ ] **Step 3: Implement browser capture and server correlation**

Use secure first-party storage with expiration and explicit consent record. Never trust client attribution to determine price/access; it is reporting metadata only.

```ts
export function captureAttribution(current: AttributionState | null, landing: LandingAttribution, at: Date): AttributionState {
  const normalized = AttributionInputSchema.parse(landing);
  return {
    firstTouch: current?.firstTouch ?? { ...normalized, capturedAt: at.toISOString() },
    lastTouch: { ...normalized, capturedAt: at.toISOString() },
    expiresAt: addMonths(at, 13).toISOString(),
  };
}

export function attributionMetadata(state: AttributionState): CheckoutAttributionMetadata {
  return { firstTouchId: opaqueAttributionId(state.firstTouch), lastTouchId: opaqueAttributionId(state.lastTouch) };
}
```

- [ ] **Step 4: Complete all native landing paths and run GREEN**

Self-Paced → sales/Checkout; Pilot → application; Scorecard → report/recommendation; Business OS → disclosed interest/offer and gated Checkout.

```ts
export const NATIVE_FUNNEL_ROUTES = {
  self_paced: { landing: "/academy", conversion: "/checkout/self-paced" },
  guided_pilot: { landing: "/pilot", conversion: "/pilot/apply" },
  scorecard: { landing: "/scorecard", conversion: "/scorecard/report" },
  business_os: { landing: "/business-os", conversion: "/checkout/business-os" },
} as const;
```

Run: `npm test -w @syntholo/web -- attribution consent && npm run test:e2e -w @syntholo/web -- acquisition.spec.ts`

Expected: PASS for all four native funnels with first/last touch and independent consent.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: complete native acquisition funnels"
```

### Task 2: Synchronize refund, recurring billing, privacy, community, and Business OS copy

**Files:**
- Create: `packages/contracts/src/legal/policy-versions.ts`
- Create: `apps/web/src/content/policies.ts`
- Create: `apps/web/src/content/policies.test.ts`
- Modify: `apps/web/src/app/{pricing,terms,privacy}/page.tsx`
- Modify: `apps/web/src/app/checkout/[offer]/page.tsx`
- Modify: `apps/worker/src/handlers/commerce/send-pilot-checkout.ts`
- Create: `docs/operations/legal-approval.md`
- Create: `infra/scripts/check-policy-copy.mjs`

**Interfaces:**
- Produces one `ACADEMY_REFUND_POLICY_VERSION` and canonical text shared by sales, Pilot email, Checkout disclosure, and terms.
- Produces policy versions for Operator Club recurring/grace/cancellation, Circle community, affiliate, analytics/privacy, and Business OS separate-login/white-label/data boundary.
- Legal approval record stores policy hash, reviewer, approval timestamp, jurisdiction notes, and effective date.

- [ ] **Step 1: Write policy-drift RED test**

Assert every required surface imports the same policy version and includes `7-day` Academy refund language. Modify one test fixture to day 10 and verify the checker fails.

```ts
it("uses one Academy refund policy on every customer surface", () => {
  const expected = { version: ACADEMY_REFUND_POLICY_VERSION, days: 7 };
  expect([pricingPolicy(), checkoutPolicy(), pilotEmailPolicy(), termsPolicy()])
    .toEqual([expected, expected, expected, expected]);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/web -- policies && node infra/scripts/check-policy-copy.mjs`

Expected: FAIL because policy copy is duplicated or not yet synchronized through one version.

- [ ] **Step 3: Centralize copy and render it on every surface**

Keep plain-language user copy with links to full terms. Commerce stores the policy version accepted at Checkout/application authorization.

```ts
export const ACADEMY_REFUND_POLICY = Object.freeze({
  version: "academy-refund-2026-08-13",
  days: 7,
  short: "Academy purchases include an unconditional 7-day refund window, subject to mandatory law.",
  termsAnchor: "/terms#academy-refunds",
});

export function AcademyRefundDisclosure() {
  return <p>{ACADEMY_REFUND_POLICY.short} <Link href={ACADEMY_REFUND_POLICY.termsAnchor}>Read the terms</Link>.</p>;
}
```

- [ ] **Step 4: Add legal approval gate**

`gate:production` remains blocked until an approved policy-hash evidence file/environment record matches current content. Code cannot self-approve.

```ts
export function evaluateLegalApproval(policy: PolicyBundle, approval: LegalApproval | null): GateResult {
  if (!approval) return { status: "blocked", code: "LEGAL_APPROVAL_MISSING" };
  if (approval.policyHash !== sha256(canonicalJson(policy))) return { status: "stale", code: "LEGAL_APPROVAL_STALE" };
  return { status: "pass", code: null };
}
```

- [ ] **Step 5: Run GREEN**

```bash
node infra/scripts/check-policy-copy.mjs
npm test -w @syntholo/web -- policies
```

Expected: PASS with the same seven-day policy version/hash on sales, Pilot email, Checkout, and terms.

- [ ] **Step 6: Commit**

```bash
git add apps packages infra docs/operations
git commit -m "docs: synchronize production policy disclosures"
```

### Task 3: Complete the authorization matrix and HTTP security controls

**Files:**
- Create: `docs/architecture/authorization-matrix.md`
- Create: `apps/api/src/plugins/{cors,csrf,rate-limit,security-headers}.ts`
- Create: `apps/api/src/plugins/security.integration.test.ts`
- Create: `apps/api/src/auth/authorization-matrix.integration.test.ts`
- Create: `apps/web/tests/e2e/authorization.spec.ts`

**Interfaces:**
- Matrix enumerates every public/member-owner/member-teammate/coach/admin/webhook route and required permission/recent-auth/account scope.
- CORS allows explicit staging/production origins only; credentialed wildcard is forbidden.
- State-changing cookie-backed requests require allowed Origin and CSRF token; bearer-only webhooks require provider signature instead.
- Rate limits apply by route risk, actor/account, and network signal with stable `RATE_LIMITED` errors and `Retry-After`.

- [ ] **Step 1: Write deny-first matrix RED tests**

Generate one test per route from the matrix. Cover anonymous, wrong provider, wrong role, wrong account, stale auth, bad origin/CSRF, malformed signature, and rate-limit threshold.

```ts
it.each(authorizationMatrix)("denies every disallowed actor for $method $path", async (route) => {
  for (const actor of route.deniedActors) {
    const response = await app.inject(requestFor(route, actor));
    expect([401, 403, 404]).toContain(response.statusCode);
    expect(response.json()).not.toHaveProperty("data");
  }
});

it("rejects a state-changing cookie request without matching origin and CSRF", async () => {
  const response = await app.inject({ method: "POST", url: "/v1/member/seats", cookies: memberCookies });
  expect(response.statusCode).toBe(403);
  expect(response.json().error.code).toBe("CSRF_REQUIRED");
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test:integration -w @syntholo/api -- security authorization-matrix && npm run test:e2e -w @syntholo/web -- authorization.spec.ts`

Expected: gaps expose missing route guards/security plugins.

- [ ] **Step 3: Implement plugins and route metadata**

Register explicit route security descriptors; fail application startup if a non-health route lacks one. Use Clerk authorized parties and Cloudflare Access issuer/audience checks from foundation.

```ts
export type RouteSecurity =
  | { surface: "public" }
  | { surface: "member"; role?: "owner" | "teammate"; recentAuthSeconds?: number }
  | { surface: "staff"; role: "coach" | "admin"; permission?: string; recentAuthSeconds?: number }
  | { surface: "webhook"; provider: "stripe" | "mux" };

export function secureRoute(options: { method: HttpMethod; url: string; security: RouteSecurity; handler: RouteHandler }) {
  return options;
}
```

- [ ] **Step 4: Run GREEN**

```bash
npm run test:integration -w @syntholo/api -- security authorization-matrix
npm run test:e2e -w @syntholo/web -- authorization.spec.ts
```

Expected: all negative tests deny without data leakage; allowed journeys pass.

- [ ] **Step 5: Commit**

```bash
git add apps docs/architecture
git commit -m "security: enforce production authorization matrix"
```

### Task 4: Implement retention, export, deletion, and legally retained records

**Files:**
- Create: `packages/domain/src/privacy/retention.ts`
- Create: `packages/domain/src/privacy/retention.test.ts`
- Create: `packages/database/src/schema/privacy.ts`
- Create: `packages/database/drizzle/0029_privacy.sql`
- Create: `apps/api/src/modules/privacy/{request-export,request-deletion,execute-deletion}.ts`
- Create: `apps/api/src/routes/{member,staff}/privacy.ts`
- Create: `apps/worker/src/handlers/privacy/{generate-export,execute-deletion}.ts`
- Create: `apps/api/src/modules/privacy/privacy.integration.test.ts`
- Create: `docs/operations/data-rights.md`

**Interfaces:**
- Customer deletion is requested with recent owner auth, soft-deletes at acceptance, deletes active copies on day 45 after a 30-day review/cancel window, and retains financial/audit or achievement facts only when a documented legal retention/hold basis applies. Without that basis, certificate PDFs are deleted and completion/certificate rows are deleted or irreversibly pseudonymized.
- Product analytics retention is 13 months; audit at least 24 months; required financial records seven years.
- Private export uses a clean private object, expires, and is delivered through a signed authorized link.

- [ ] **Step 1: Write lifecycle/retention RED tests**

Cover owner vs teammate, recent auth, request/cancel, day 30/day 45, legal hold, financial/audit/certificate preservation, Blob deletion, provider erasure queue, and export authorization.

```ts
it("deletes active customer data on day 45 and retains only required records", async () => {
  const request = await requestDeletion(ownerCommand({ requestedAt: day(0) }), deps);
  await executeDeletion(job({ requestId: request.id, now: day(45) }), deps);
  expect(await memberships.findActive(accountId)).toEqual([]);
  expect(await financial.countForAccount(accountId)).toBeGreaterThan(0);
  expect(await audit.countForAccount(accountId)).toBeGreaterThan(0);
  expect(await certificates.containsPersonalData(accountId)).toBe(false);
  expect(await blob.exists(certificateObjectKey(courseCompletionId))).toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/privacy && npm run test:integration -w @syntholo/api -- privacy.integration.test.ts`

Expected: FAIL because retention, export, and deletion commands do not exist.

- [ ] **Step 3: Implement deletion manifest and durable provider cleanup**

Build an explicit table/provider manifest. Pseudonymize retained references where legally allowed, record counts and errors, and never hard-delete audit history via runtime repository.

```ts
export const DELETION_MANIFEST: readonly DeletionStep[] = [
  { target: "support_messages", action: "delete" },
  { target: "artifact_versions", action: "delete" },
  { target: "member_identities", action: "pseudonymize" },
  { target: "financial_records", action: "retain", retentionYears: 7 },
  { target: "audit_events", action: "retain", retentionMonths: 24 },
  { target: "certificate_files", action: "delete" },
  { target: "certificate_records", action: "pseudonymize_unless_legal_hold" },
];
```

- [ ] **Step 4: Run GREEN**

```bash
npm test -w @syntholo/domain -- src/privacy
npm run test:integration -w @syntholo/api -- privacy.integration.test.ts
```

Expected: PASS for owner authorization, day-45 deletion, provider cleanup, export, and required-history retention.

- [ ] **Step 5: Commit**

```bash
git add apps packages docs/operations
git commit -m "feat: operate data export and deletion"
```

### Task 5: Create the complete CI quality matrix and protected-branch contract

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/CODEOWNERS`
- Create: `infra/scripts/check-contract-compatibility.mjs`
- Create: `infra/scripts/check-migration-safety.mjs`
- Create: `docs/operations/branch-protection.md`
- Modify: `package.json`

**Interfaces:**
- PR CI runs lint, typecheck, unit, contract compatibility, PostgreSQL integration/RLS, service builds, relevant E2E, accessibility, responsive, visual, policy/isolation checks, and migration safety.
- Contract checker compares OpenAPI/Zod snapshots and permits additive backward-compatible changes; breaking removals require a versioned route/schema.
- Migration checker blocks destructive SQL without expand/contract annotation, recovery point, staged rehearsal, and rollback command.

- [ ] **Step 1: Write checker RED fixtures**

Include removed response field, nullable-to-required change, dropped column, rewritten published migration, and safe additive examples.

```ts
it.each([
  [contractChange({ removedField: "correlationId" }), "BREAKING_CONTRACT_REMOVAL"],
  [migration("alter table accounts drop column name"), "DESTRUCTIVE_MIGRATION"],
  [migration("alter table accounts add column timezone text"), null],
])("classifies CI compatibility changes", async (fixture, expectedCode) => {
  const result = await checkCompatibility(fixture);
  expect(result.code).toBe(expectedCode);
});
```

- [ ] **Step 2: Run RED**

Run: `node infra/scripts/check-contract-compatibility.mjs --fixture breaking && node infra/scripts/check-migration-safety.mjs --fixture destructive`

Expected: FAIL because compatibility and migration-safety checkers do not exist.

- [ ] **Step 3: Implement CI jobs with artifact evidence**

Use `npm ci`, disposable PostgreSQL/ClamAV, deterministic release SHA, Playwright artifacts on failure, and no production secrets. Require CODEOWNERS review for migrations, auth, commerce, entitlements, privacy, and deployment files.

```yaml
jobs:
  quality:
    runs-on: ubuntu-latest
    strategy:
      matrix: { suite: [static, unit, integration, browser, build, security] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run ci:${{ matrix.suite }}
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: evidence-${{ matrix.suite }}, path: test-results }
```

- [ ] **Step 4: Run local equivalents**

```bash
npm run ci:local
git diff --check
```

Expected: PASS for every CI matrix suite and the diff whitespace check.

- [ ] **Step 5: Commit**

```bash
git add .github infra docs/operations package.json
git commit -m "ci: enforce the production quality matrix"
```

### Task 6: Configure Vercel, Railway, Neon, environments, secrets, and deployments

**Files:**
- Create: `apps/web/vercel.json`
- Modify: `infra/railway/{api,worker}.toml`
- Create: `infra/railway/cron.toml`
- Create: `infra/neon/roles.sql`
- Create: `infra/scripts/validate-environment.mjs`
- Create: `.github/workflows/{deploy-staging,deploy-production}.yml`
- Create: `docs/operations/environment-setup.md`
- Create: `docs/operations/deployment.md`

**Interfaces:**
- Environments expose separate public web URL, API URL, database roles, provider endpoints/keys, webhook secrets, Blob prefixes, Circle groups, analytics project, Sentry environment, and email allowlist.
- Production deployment accepts immutable reviewed SHA and current gate evidence; staging auto-deploys after CI.
- Deploy workflow runs backward-compatible migration, API readiness, worker heartbeat, web smoke, then annotates release.

- [ ] **Step 1: Write environment-isolation RED tests**

Feed duplicate staging/production keys/project IDs/prefixes and expect failure. Feed production secrets to preview configuration and expect failure. Omit database restore configuration and expect blocked production gate.

```ts
it("requires isolated staging and production providers", () => {
  const result = validateEnvironmentPair(environment({ stripeAccount: "acct_same" }), environment({ stripeAccount: "acct_same" }));
  expect(result.violations).toContainEqual({ field: "stripeAccount", code: "ENVIRONMENT_NOT_ISOLATED" });
});

it("denies production credentials in preview", () => {
  expect(() => validatePreviewEnvironment({ ...previewEnv, DATABASE_URL: productionEnv.DATABASE_URL })).toThrow("PRODUCTION_SECRET_IN_PREVIEW");
});
```

- [ ] **Step 2: Run RED**

Run: `node infra/scripts/validate-environment.mjs --fixtures infra/fixtures/environment-isolation.json`

Expected: FAIL because deployment environment isolation validation does not exist.

- [ ] **Step 3: Implement configs and validation**

Keep actual secrets in provider stores, never Git. Use pooled Neon URL for API/worker, direct URL for migrations, least-privilege roles, region alignment, non-root containers, and health-based deploy success.

```ts
export const DeploymentEnvironmentSchema = z.object({
  ENVIRONMENT: z.enum(["staging", "production"]),
  RELEASE_SHA: z.string().regex(/^[0-9a-f]{40}$/),
  DATABASE_POOLED_URL: z.string().url(),
  DATABASE_DIRECT_URL: z.string().url(),
  CLERK_INSTANCE_ID: z.string().min(1),
  REMOVED_CLIENT_ID: z.string().min(1),
  STRIPE_ACCOUNT_ID: z.string().startsWith("acct_"),
  BLOB_PREFIX: z.string().min(1),
  CIRCLE_WRITE_GROUP_ID: z.string().min(1),
  SENTRY_ENVIRONMENT: z.enum(["staging", "production"]),
}).strict();
```

- [ ] **Step 4: Rehearse staging deployment**

Run migration → API → worker/cron → web; confirm release SHA and dependency health. Simulate API deploy failure and verify web remains on compatible prior version.

- [ ] **Step 5: Commit**

```bash
git add apps/web/vercel.json infra .github docs/operations
git commit -m "ops: configure production deployment topology"
```

### Task 7: Prove backup restore, migration rollback, service rollback, and provider degradation

**Files:**
- Create: `.github/workflows/restore-drill.yml`
- Create: `infra/scripts/{create-recovery-point,restore-drill,rollback-release,degrade-provider}.mjs`
- Create: `apps/web/tests/e2e/recovery.spec.ts`
- Create: `docs/operations/{restore,rollback,provider-degradation}.md`

**Interfaces:**
- Restore drill provisions an isolated Neon branch/project from the approved restore point, verifies critical counts/constraints and signed sample hashes, then destroys only the explicit drill target.
- Rollback disables affected server capability first, deploys last compatible versions, leaves forward-compatible schema, and replays only safe jobs by idempotency key.
- Degradation scenarios cover PostgreSQL, Clerk, Cloudflare Access, Stripe, Mux, Resend, Circle, HighLevel, Blob/ClamAV, PostHog, and Sentry.

- [ ] **Step 1: Write recovery/degradation RED tests**

Assert DB unavailable is read-only/degraded without demo data; Mux shows transcript; Resend queues; Circle retries; HighLevel affects Business OS only; analytics/monitoring failures do not block core writes; exhausted jobs dead-letter visibly.

```ts
test("provider failures remain inside their domains", async ({ page, degradation }) => {
  await degradation.disable("mux");
  await page.goto("/learn/course/lesson-1");
  await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible();
  await degradation.disable("circle");
  await page.goto("/learn/community");
  await expect(page.getByText(/community access is syncing/i)).toBeVisible();
  await page.goto("/learn/course");
  await expect(page.getByRole("heading", { name: "Your course" })).toBeVisible();
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test:e2e -w @syntholo/web -- recovery.spec.ts && node infra/scripts/restore-drill.mjs --dry-run --fixture invalid-target`

Expected: FAIL because recovery scripts and degraded UI contracts do not exist.

- [ ] **Step 3: Implement safe scripts and runbooks**

Require explicit environment/project IDs, confirmation token, and dry run. Never target workspace root or unresolved environment variables for destructive cleanup. Record RPO/RTO measurements and rollback evidence.

```js
export function assertDrillTarget(input) {
  if (!input.projectId || !input.branchId || !input.confirmationToken) throw new Error("EXPLICIT_DRILL_TARGET_REQUIRED");
  if (input.projectId === input.productionProjectId) throw new Error("PRODUCTION_TARGET_FORBIDDEN");
  if (!input.branchId.startsWith("restore-drill-")) throw new Error("DRILL_BRANCH_PREFIX_REQUIRED");
  return input;
}
```

- [ ] **Step 4: Run staging drills**

Restore current staging backup into isolated target; rehearse one expand/contract migration rollback; degrade each adapter; verify RPO ≤24h and RTO ≤8h.

- [ ] **Step 5: Commit**

```bash
git add .github infra apps/web/tests/e2e docs/operations
git commit -m "ops: add recovery and rollback drills"
```

### Task 8: Run performance, accessibility, responsive, and data-leak hardening

**Files:**
- Create: `tests/performance/api-smoke.mjs`
- Create: `apps/web/tests/e2e/production-accessibility.spec.ts`
- Create: `apps/web/tests/e2e/data-leak.spec.ts`
- Modify: `apps/web/tests/e2e/visual-contracts.spec.ts`
- Modify: `apps/web/tests/e2e/visual-regression.spec.ts`
- Create: `infra/scripts/check-bundle-and-secrets.mjs`
- Create: `docs/operations/performance-budget.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Capacity scenario models 250 businesses × 3 members, concurrent learning reads, support writes, webhooks, reminders, and worker backlog.
- Initial budgets: API p95 read <400 ms, write <700 ms under target load; no sustained database pool exhaustion; queue age <5 minutes for priority jobs and <15 minutes for normal jobs.
- WCAG 2.1 AA and existing minimum text/touch/overflow/reduced-motion contracts remain required.

- [ ] **Step 1: Write failing budget/leak checks**

Scan built client bundles/source maps/network responses/log fixtures for server secrets, provider payloads, unauthorized account data, private signed URLs, and restricted analytics/error fields.

```ts
test("client output and responses contain no privileged values", async ({ page }) => {
  const leaks: string[] = [];
  page.on("response", async (response) => {
    const body = await response.text().catch(() => "");
    for (const pattern of forbiddenProductionPatterns) if (pattern.test(body)) leaks.push(pattern.source);
  });
  await memberJourney(page);
  expect(leaks).toEqual([]);
});
```

Create the exact Autocannon smoke runner:

```bash
npm install --save-dev autocannon
```

```js
import autocannon from "autocannon";

const result = await autocannon({
  url: process.env.PERFORMANCE_API_URL,
  connections: 50,
  duration: 60,
  requests: [{ method: "GET", path: "/v1/member/dashboard", headers: { authorization: `Bearer ${process.env.PERFORMANCE_MEMBER_TOKEN}` } }],
});

if (result.latency.p95 > 400 || result.errors > 0 || result.timeouts > 0) process.exitCode = 1;
```

- [ ] **Step 2: Run RED where production routes remain unoptimized**

Run: `npm run test:performance && npm run test:e2e -w @syntholo/web -- production-accessibility.spec.ts data-leak.spec.ts`

Expected: FAIL on any measured budget, accessibility contract, or restricted-data leak that remains.

- [ ] **Step 3: Add indexes, pagination, cache boundaries, and UI fixes based on evidence**

Use query plans and measured traces. Do not cache member data across accounts; public content can use version-keyed caching. Paginate staff queues and histories.

```ts
export const CursorPageSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
});

export function publicContentCacheKey(courseVersionId: string, lessonVersionId: string): string {
  return `public-content:${courseVersionId}:${lessonVersionId}`;
}

// Member queries deliberately include immutable account scope and are not shared-cache entries.
export const memberQueryScope = (actor: MemberActor) => ({ accountId: actor.accountId, membershipId: actor.membershipId });
```

- [ ] **Step 4: Run the hardening suite**

```bash
npm run test:performance
npm run test:e2e -w @syntholo/web -- production-accessibility.spec.ts data-leak.spec.ts visual-contracts.spec.ts visual-regression.spec.ts
npm run check:bundle-secrets
```

Expected: budgets and accessibility pass at desktop/mobile/intermediate widths; no restricted field or secret is found.

- [ ] **Step 5: Commit**

```bash
git add apps tests infra docs/operations
git commit -m "perf: harden production capacity and accessibility"
```

### Task 9: Remove remaining demo/runtime stubs from production surfaces

**Files:**
- Create: `apps/api/src/modules/member/get-dashboard.ts`
- Create: `apps/api/src/modules/operations/get-admin-overview.ts`
- Create: `apps/api/src/routes/{member/dashboard,staff/admin-overview}.ts`
- Create: `apps/web/src/lib/api/{member-dashboard,admin-overview}.ts`
- Modify: `apps/web/src/features/dashboard/member-dashboard.tsx`
- Modify: `apps/web/src/app/learn/templates/page.tsx`
- Modify: `apps/web/src/app/learn/settings/[section]/page.tsx`
- Modify: `apps/web/src/app/admin/page.tsx`
- Modify: `apps/web/src/app/admin/[section]/page.tsx`
- Delete: `apps/web/src/lib/demo/repository.ts`
- Delete: `apps/web/src/lib/demo/repository.test.ts`
- Delete: `apps/web/src/lib/demo/data.ts`
- Create: `packages/testing/src/demo-fixtures.ts`
- Modify: `apps/web/package.json`
- Create: `infra/scripts/check-production-imports.mjs`
- Create: `infra/scripts/check-production-imports.test.ts`
- Create: `apps/web/tests/e2e/production-route-inventory.spec.ts`

**Interfaces:**
- Produces `GET /v1/member/dashboard` from learning, support, sessions, entitlements, and Business OS query ports; it returns no demo/provider records.
- Produces `GET /v1/staff/admin-overview` from applications, commerce summaries, content readiness, coach queue, jobs/incidents, and Business OS verification.
- Produces `npm run check:production-imports`, which rejects production imports from `apps/web/src/lib/demo`, direct vendor integration stubs, MongoDB, or browser-only repositories.
- Retains deterministic synthetic factories only under `packages/testing` and Playwright fixture paths.

- [ ] **Step 1: Write the production-import and route-inventory RED tests**

```ts
it("rejects a production route importing demo data", async () => {
  const result = await checkProductionImports(fixtureTree({
    "apps/web/src/app/learn/page.tsx": 'import { repository } from "@/lib/demo/repository"',
  }));
  expect(result.violations).toContainEqual(expect.objectContaining({ code: "PRODUCTION_DEMO_IMPORT" }));
});

test("every production route renders with demo mode disabled", async ({ page }) => {
  for (const route of productionRouteInventory) {
    const response = await page.goto(route);
    expect(response?.status()).toBeLessThan(500);
    await expect(page.locator("body")).not.toContainText("Demo data unavailable");
  }
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/testing -- check-production-imports.test.ts && APP_MODE=production npm run test:e2e -w @syntholo/web -- production-route-inventory.spec.ts`

Expected: FAIL because the current dashboard/admin/secondary routes still import the deterministic demo repository and MongoDB remains in the web package.

- [ ] **Step 3: Add production dashboard and admin overview queries**

```ts
export async function getMemberDashboard(command: GetMemberDashboard, deps: DashboardDeps): Promise<MemberDashboardResponse> {
  const [access, learning, support, sessions, businessOs] = await Promise.all([
    deps.entitlements.forActor(command.actor), deps.learning.getSummary(command.actor),
    deps.support.getSummary(command.actor), deps.sessions.getUpcoming(command.actor),
    deps.businessOs.getMemberSummary(command.actor),
  ]);
  return composeMemberDashboard({ access, learning, support, sessions, businessOs });
}

export async function getAdminOverview(command: GetAdminOverview, deps: AdminOverviewDeps): Promise<AdminOverviewResponse> {
  requirePermission(command.actor, "operations:read");
  return deps.overview.load({ asOf: deps.clock.now() });
}
```

- [ ] **Step 4: Replace remaining demo reads and remove MongoDB**

```tsx
export async function MemberHomePage() {
  const dashboard = await memberDashboardApi().get();
  return <MemberDashboard dashboard={dashboard} />;
}

export async function AdminHomePage() {
  const overview = await adminOverviewApi().get();
  return <AdminOverview overview={overview} />;
}
```

Move any still-useful deterministic objects to `packages/testing`; production code must receive typed API responses. Make legacy admin section routes render a production module or a deliberate `notFound()`, never a generic demo table. Re-run the foundation MongoDB dependency assertion as a regression.

- [ ] **Step 5: Run GREEN**

Run: `npm run check:production-imports && APP_MODE=production npm run test:e2e -w @syntholo/web -- production-route-inventory.spec.ts && npm run build -w @syntholo/web`

Expected: PASS for every public/member/coach/admin route; client bundles contain no MongoDB package, demo repository, or privileged integration stub.

- [ ] **Step 6: Commit**

```bash
git add apps packages infra package.json package-lock.json
git commit -m "refactor: remove production demo data paths"
```

### Task 10: Build the machine-readable six-gate release controller

**Files:**
- Create: `packages/contracts/src/operations/release-gates.ts`
- Create: `infra/scripts/gate-production.mjs`
- Create: `infra/scripts/gate-production.test.ts`
- Create: `apps/api/src/modules/operations/release-gates.ts`
- Create: `apps/api/src/routes/staff/release-gates.ts`
- Create: `apps/web/src/app/admin/operations/release/page.tsx`
- Modify: `package.json`

**Interfaces:**
- Gate result is `pass | blocked | stale`, includes evidence hash/time/source/owner, and has no generic manual “force pass”.
- Capability flags are server-owned: `academy_checkout`, `pilot_checkout`, `operator_club`, `business_os_checkout`, and `public_acquisition`.
- Academy capability requires Gates 1–5 plus current curriculum/legal evidence; Business OS additionally requires its independent readiness; public acquisition requires controlled validation observation.

- [ ] **Step 1: Write gate-composition RED tests**

Cover missing remote, CI failure, stale curriculum hash, missing legal approval, untrained coach, vendor missing, restore failure, controlled purchase absent, 47 vs 48 observation hours, Academy ready/Business OS blocked, and all pass.

```ts
it("keeps independent capabilities independently blocked", () => {
  const result = evaluateReleaseCapabilities(evidence({
    foundation: "pass", workflows: "pass", curriculum: "pass", staging: "pass", controlledValidation: "pass",
    businessOsReadiness: "blocked",
  }));
  expect(result.academy_checkout).toBe(true);
  expect(result.business_os_checkout).toBe(false);
});

it("requires 48 complete observation hours", () => {
  expect(evaluateControlledValidation({ ...validControlledEvidence(), observationHours: 47 }).status).toBe("blocked");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/testing -- gate-production.test.ts`

Expected: FAIL because the six-gate capability evaluator does not exist.

- [ ] **Step 3: Implement evidence adapters and capability evaluation**

Read test artifacts, deployment health, persisted approvals, curriculum report, vendor/staff checklists, restore/drill results, and controlled validation. UI can request a capability change, but API re-evaluates and audits before changing state.

```ts
export function evaluateReleaseCapabilities(evidence: ReleaseEvidence): ReleaseCapabilities {
  const academyReady = allPass([evidence.foundation, evidence.workflows, evidence.curriculum, evidence.staging, evidence.controlledValidation, evidence.legal]);
  return {
    academy_checkout: academyReady,
    pilot_checkout: academyReady,
    operator_club: academyReady,
    business_os_checkout: allPass([evidence.foundation, evidence.commerce, evidence.businessOsReadiness, evidence.legal]),
    public_acquisition: academyReady && evidence.observationHours >= 48 && evidence.acquisitionQuality === "pass",
  };
}
```

- [ ] **Step 4: Run GREEN and verify fail-closed behavior**

Remove one evidence file/dependency and assert the related capability turns off while unrelated capabilities remain.

Run: `npm test -w @syntholo/testing -- gate-production.test.ts && npm run gate:production`

Expected: PASS; the removed dependency blocks only its dependent capability and the gate never falls back to a client flag.

- [ ] **Step 5: Commit**

```bash
git add apps packages infra package.json
git commit -m "feat: enforce production release gates"
```

### Task 11: Rehearse staging and controlled production validation

**Files:**
- Create: `apps/web/tests/e2e/release.spec.ts`
- Create: `docs/operations/staging-rehearsal.md`
- Create: `docs/operations/controlled-production-validation.md`
- Create: `docs/operations/incident-response.md`
- Create: `docs/operations/on-call.md`
- Modify: `infra/scripts/gate-production.mjs`

**Interfaces:**
- Produces signed evidence for Gate 4 and Gate 5, tied to release SHA and environment.
- Controlled transaction evidence includes one low-value real purchase, webhook, claim, receipt, access grant, refund, grant reversal, and preservation checks.
- Starts a 48-hour observation only after all critical monitors, owners, staff MFA, coach rotation, sessions, and provider health are green.

- [ ] **Step 1: Run the full staging rehearsal**

Execute flows 1–6; authorization matrix; scan/quarantine; Circle outage; Business OS degradation; certificate independence; data export/deletion; restore; migration rollback; provider degradation; performance/accessibility; and incident escalation.

```ts
export const STAGING_REHEARSAL_CHECKS = [
  "flow_1_self_paced", "flow_2_pilot", "flow_3_support_review", "flow_4_content_certificate",
  "flow_5_recurring_business_os", "flow_6_refund_dispute", "authorization_matrix", "file_quarantine",
  "circle_degradation", "business_os_degradation", "certificate_independence", "data_rights",
  "restore", "migration_rollback", "provider_degradation", "performance", "accessibility", "incident_escalation",
] as const;
```

- [ ] **Step 2: Fix every Critical/Important finding through a separate RED/GREEN task**

Do not waive cross-account, identity, money-idempotency, entitlement-reversal, payment/claim, data-loss, or critical availability failures.

```ts
export function canAcceptRehearsal(findings: readonly Finding[]): boolean {
  return findings.every((finding) => finding.severity !== "critical" && finding.severity !== "important");
}
```

- [ ] **Step 3: Deploy reviewed SHA and execute controlled transaction**

Use the approved low-value method and production customer/test identity. Record Stripe/provider IDs securely, verify exact grants, refund, re-evaluate access, and prove audit/progress/certificate preservation.

- [ ] **Step 4: Observe for 48 hours**

Monitor errors, latency, webhook lag, queue age, dead letters, email, claim, course/support, Circle sync, and database recovery indicators. Reset observation if a critical incident occurs.

- [ ] **Step 5: Mark Gate 5 only with complete evidence**

Run: `npm run gate:production -- --gate controlled-production`

Expected: `PASS` only when the reviewed SHA, controlled transaction, preservation checks, monitoring, staffing, and complete 48-hour observation evidence all match.

- [ ] **Step 6: Commit runbook/evidence references**

```bash
git add docs/operations infra
git commit -m "ops: record controlled production validation"
```

### Task 12: Launch capped acquisition and daily operating review

**Files:**
- Create: `docs/operations/acquisition-launch.md`
- Create: `docs/operations/daily-launch-review.md`
- Create: `apps/web/src/app/admin/operations/acquisition/page.tsx`
- Create: `apps/web/tests/e2e/acquisition-operations.spec.ts`
- Modify: `infra/scripts/gate-production.mjs`

**Interfaces:**
- Dashboard reports attribution completeness, landing→Checkout/application, Checkout completion, claim reliability, 7-day first lesson, support SLA, refund/dispute, queue health, and Business OS incident state.
- Targets: ≥80% paid accounts begin within seven days, ≥60% Self-Paced completion, Academy refunds <8%, median substantive coach reply <2 business days, and support ≤20 minutes/active business/month.
- Spend state `off | capped | scaling | paused`; only admin with recent auth can change it, and scaling requires current quality thresholds.

- [ ] **Step 1: Write acquisition-state RED tests**

Block spend when attribution incomplete, payment/claim below threshold, support overloaded, refunds ≥8%, critical incident open, or gate evidence stale. Allow capped start only when all Gate 6 inputs pass.

```ts
it.each([
  [{ attributionCompleteness: 0.8 }, "ATTRIBUTION_INCOMPLETE"],
  [{ refundRate: 0.08 }, "REFUND_RATE_TOO_HIGH"],
  [{ criticalIncidentOpen: true }, "CRITICAL_INCIDENT_OPEN"],
])("blocks acquisition on quality failure", (patch, reason) => {
  expect(evaluateSpendState({ ...healthyLaunchMetrics(), ...patch })).toEqual({ allowed: false, reason });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- acquisition && npm run test:e2e -w @syntholo/web -- acquisition-operations.spec.ts`

Expected: FAIL because spend-state quality controls and the operations projection do not exist.

- [ ] **Step 3: Implement privacy-safe operations projection and controls**

Aggregate by campaign/offer/date without customer content. Alert on missing attribution, webhook/claim failures, SLA breach, refund spike, or incident. Provide pause capability that disables server offer entry while preserving existing members.

```ts
export function evaluateSpendState(metrics: LaunchMetrics): SpendDecision {
  if (metrics.attributionCompleteness < 0.95) return { allowed: false, reason: "ATTRIBUTION_INCOMPLETE" };
  if (metrics.claimReliability < 0.99) return { allowed: false, reason: "CLAIM_RELIABILITY_LOW" };
  if (metrics.refundRate >= 0.08) return { allowed: false, reason: "REFUND_RATE_TOO_HIGH" };
  if (metrics.criticalIncidentOpen) return { allowed: false, reason: "CRITICAL_INCIDENT_OPEN" };
  return { allowed: true, reason: null };
}
```

- [ ] **Step 4: Run final production gate**

```bash
npm ci
npm run ci:local
npm run gate:foundation
npm run gate:commerce
npm run gate:content
npm run gate:human-operations
npm run gate:business-os
npm run gate:production
git diff --check
```

Expected: technical gates pass; Gate 3/5/6 remain `BLOCKED` until real curriculum, external approvals/resources, and controlled production evidence are supplied.

- [ ] **Step 5: Self-review**

Confirm no gate can be client-bypassed, payment stays off before curriculum approval, policy copy matches, environment isolation/rollback is proven, and acquisition can be paused without affecting active members.

- [ ] **Step 6: Commit**

```bash
git add apps docs/operations infra package.json
git commit -m "feat: operate controlled Syntholo acquisition"
```
