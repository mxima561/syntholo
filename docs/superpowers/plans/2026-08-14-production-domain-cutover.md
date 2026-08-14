# Production Domain Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the production web and identity boundaries to `https://app.syntholo.com` without exposing backend credentials, then publish any required reviewed correction under one newer exact release identity.

**Architecture:** Vercel serves the canonical web hostname and keeps the existing relative `/v1` rewrite to Railway. Clerk moves from the temporary `syntholo.vercel.app` proxy configuration to DNS mode on the owned domain, while WorkOS and Railway consume the same canonical origin. Provider changes are ordered so DNS and redirect validation precede origin cutover.

**Tech Stack:** Vercel CLI, Railway CLI, Clerk Backend API 2026-05-12, WorkOS Dashboard/API, GoDaddy DNS, Next.js 16, Fastify, curl/dig

**Spec:** `docs/superpowers/specs/2026-08-14-production-domain-cutover-design.md`

## Global Constraints

- Canonical web origin is exactly `https://app.syntholo.com`.
- The apex `syntholo.com` is unchanged.
- Clerk secret and WorkOS secret remain only in Railway API; Vercel receives no backend credential.
- The browser continues to call relative `/v1` paths through the Vercel rewrite.
- All deployments and health responses remain bound to Git SHA `0843b6e9835a0899b193edb2c4ba8b84d331a574` unless an intentional repository change creates and pushes a newer reviewed SHA. The embedded-auth routing correction does create such a release.
- Provider credentials must never appear in terminal output, logs, patches, commits, or reports.
- A provider validation failure stops the cutover before dependent origins are changed.

---

### Task 1: Verify the canonical Vercel hostname

**Files:**
- Read: `apps/web/src/proxy.ts`
- Read: `apps/web/src/lib/config/canonical-host.ts`
- Test: `apps/web/src/lib/config/canonical-host.test.ts`

**Interfaces:**
- Consumes: Vercel project `prj_4KSSshgT0VZelpiyAeni2uyJ6PHt` and DNS for `app.syntholo.com`.
- Produces: verified Vercel DNS/TLS attachment before any identity-provider change.

- [ ] **Step 1: Verify DNS points to Vercel**

```bash
dig +short CNAME app.syntholo.com
dig +short A app.syntholo.com
```

Expected: a Vercel DNS target is returned and the hostname resolves.

- [ ] **Step 2: Verify Vercel owns the alias and TLS is ready**

```bash
npx vercel domains inspect app.syntholo.com --scope karim-7393s-projects
curl -fsSI https://app.syntholo.com
```

Expected: Vercel reports the domain and curl completes with a valid TLS chain. A redirect to the old hostname is acceptable only before `WEB_ORIGIN` changes.

- [ ] **Step 3: Run the canonical-host unit tests**

```bash
npm test -w @syntholo/web -- src/lib/config/canonical-host.test.ts
```

Expected: PASS; redirect behavior derives from the configured fixed `WEB_ORIGIN`.

### Task 2: Move Clerk to DNS mode

**Files:**
- Read: `packages/integrations/src/clerk/client.ts`
- Read: `apps/web/src/components/public-auth.tsx`
- Modify externally: Clerk domain `dmn_3Hv3WdK9wxVBAvcnngFE8mOxhK7`
- Modify externally: GoDaddy DNS zone `syntholo.com`

**Interfaces:**
- Consumes: Railway `CLERK_SECRET_KEY` without printing it and Clerk domain API.
- Produces: verified Clerk Frontend API, DKIM, and mail DNS records for `app.syntholo.com`, with `proxy_url=null`; no Account Portal record is inferred.

- [ ] **Step 1: Read the current Clerk domain object without printing credentials**

```bash
railway_vars=$(npx @railway/cli variable list --service API --environment production --project 7d964d5c-632d-4205-9f85-8e00b3038885 --json)
clerk_secret=$(printf '%s' "$railway_vars" | jq -r '.CLERK_SECRET_KEY')
curl -fsS https://api.clerk.com/v1/domains \
  -H "Authorization: Bearer $clerk_secret" \
  -H 'Clerk-API-Version: 2026-05-12' \
  | jq -c '.data[] | {id,name,proxy_url,cname_targets}'
```

Expected: the primary domain ID matches the documented ID and the current temporary proxy configuration is visible.

- [ ] **Step 2: Request the owned primary domain in DNS mode**

```bash
curl -fsS -X PATCH \
  https://api.clerk.com/v1/domains/dmn_3Hv3WdK9wxVBAvcnngFE8mOxhK7 \
  -H "Authorization: Bearer $clerk_secret" \
  -H 'Clerk-API-Version: 2026-05-12' \
  -H 'Content-Type: application/json' \
  --data '{"name":"app.syntholo.com","proxy_url":null}' \
  | jq -c '{id,name,frontend_api_url,accounts_portal_url,proxy_url,cname_targets}'
```

Expected: Clerk returns DNS targets for the new domain and no proxy URL. If the
PATCH is rejected, stop before changing WorkOS or either runtime origin and
record Clerk's exact response for a revised provider-specific plan.

- [ ] **Step 3: Add only the exact Clerk-returned CNAME records in GoDaddy**

Use the returned `cname_targets`; do not infer hostnames. Preserve the existing `app` Vercel CNAME and all unrelated apex/mail records.

- [ ] **Step 4: Verify Clerk DNS and endpoints**

```bash
dig +short CNAME clerk.app.syntholo.com
dig +short CNAME clk._domainkey.app.syntholo.com
dig +short CNAME clk2._domainkey.app.syntholo.com
dig +short CNAME clkmail.app.syntholo.com
curl -fsS https://clerk.app.syntholo.com/.well-known/jwks.json | jq -e '.keys | length > 0'
```

Expected: all four Clerk-returned CNAMEs resolve exactly and JWKS contains at
least one key. Re-read the Clerk domain object and require `proxy_url=null`, the
exact new domain name, and the returned CNAME targets before continuing. Clerk
did not return an Account Portal CNAME for this instance; do not invent one.

- [ ] **Step 5: Replace platform keys only if Clerk rotates them**

If Clerk returns a new publishable or secret key, copy it directly into the same existing Vercel/Railway variables without displaying it. If keys remain stable, make no credential change.

### Task 3: Update canonical origins, local auth routes, and callbacks

**Files:**
- Read: `apps/api/src/config.ts`
- Read: `apps/web/src/lib/api/config.ts`
- Modify: `apps/web/src/components/public-auth.tsx`
- Test: `apps/web/src/components/public-auth.test.tsx`
- Read: `docs/architecture/identity-and-sessions.md`
- Modify externally: Vercel production `WEB_ORIGIN`
- Modify externally: Railway API production `WEB_ORIGIN`
- Modify externally: WorkOS redirect URI

**Interfaces:**
- Consumes: verified Clerk DNS from Task 2.
- Produces: one canonical hostname for web redirect, embedded Clerk routes, API CORS/cookie decisions, and WorkOS callback.

- [ ] **Step 1: Update WorkOS redirect URI first**

Set the application homepage, initiate-login URI, and production callback to:

```text
https://app.syntholo.com
https://app.syntholo.com/v1/staff/auth/sign-in
https://app.syntholo.com/v1/staff/auth/callback
```

Keep only the exact production callback after live verification.

- [ ] **Step 2: Keep Clerk navigation on local embedded routes**

```text
/sign-in
/sign-up
```

Configure Clerk path routing explicitly and test that each form links to the
other local route. Do not depend on `accounts.app.syntholo.com`.

- [ ] **Step 3: Update Vercel production origin**

```bash
printf '%s' 'https://app.syntholo.com' \
  | npx vercel env update WEB_ORIGIN production --yes --no-sensitive \
      --project syntholo --scope karim-7393s-projects
```

Expected: Vercel confirms the production variable was replaced.

- [ ] **Step 4: Update Railway API origin without triggering an intermediate deploy**

```bash
printf '%s' 'https://app.syntholo.com' \
  | npx @railway/cli variable set WEB_ORIGIN --stdin --skip-deploys \
      --service API --environment production \
      --project 7d964d5c-632d-4205-9f85-8e00b3038885
```

Expected: Railway confirms only the API variable was changed.

- [ ] **Step 5: Confirm Vercel remains free of backend credentials**

Pull production variables to an ignored file and report only key names. Fail if `CLERK_SECRET_KEY`, `WORKOS_API_KEY`, database URLs, or another forbidden server credential is present.

### Task 4: Redeploy and verify the cutover

**Files:**
- Read: `infra/scripts/gate-foundation.mjs`
- Read: `docs/operations/foundation-deploy.md`

**Interfaces:**
- Consumes: provider state from Tasks 1-3.
- Produces: live web/API deployments on the canonical hostname with validated identity flows.

- [ ] **Step 1: Redeploy Railway API**

```bash
npx @railway/cli redeploy --service API --environment production \
  --project 7d964d5c-632d-4205-9f85-8e00b3038885 --yes --json
```

Poll until the latest API deployment is `SUCCESS`; stop on `FAILED` or `CRASHED` and inspect logs.

- [ ] **Step 2: Redeploy Vercel production**

Redeploy the accepted production deployment with target `production`, preserving the required webpack build command and accepted Git metadata. Poll until `readyState=READY`.

- [ ] **Step 3: Verify canonical routing and release identity**

```bash
curl -fsS https://app.syntholo.com/api/health | jq -e '.status == "ok"'
curl -fsS https://app.syntholo.com/v1/health/ready | jq -e '.status == "ok"'
curl -fsSI https://syntholo.vercel.app/launch-check?source=alias
```

Expected: both health responses report the deployed Git SHA; the old alias redirects to `https://app.syntholo.com/launch-check?source=alias`.

- [ ] **Step 4: Verify member identity**

Open `https://app.syntholo.com/sign-in`; verify ClerkJS loads from the verified
production Frontend API, there are no DNS/proxy errors, its sign-up action stays
on `https://app.syntholo.com/sign-up`, and an unauthenticated protected member
request returns the documented 401 rather than 500. Repeat the reciprocal link
check from `/sign-up`.

- [ ] **Step 5: Verify staff identity**

```bash
curl -fsSI https://app.syntholo.com/v1/staff/auth/sign-in
```

Expected: redirect uses the existing WorkOS client/organization and exact `app.syntholo.com` callback. The login cookie remains `Secure`, `HttpOnly`, `SameSite=Lax`, host-only, and `Path=/`.

- [ ] **Step 6: Run local regression gates**

```bash
npm run typecheck
npm run lint
npm test
git diff --check
```

Expected: all locally executable checks pass.

### Task 5: Record evidence and hand off

**Files:**
- Modify: `docs/architecture/identity-and-sessions.md`
- Modify: `docs/operations/foundation-deploy.md`
- Modify: `.superpowers/sdd/2026-08-13-production-foundation/task-9-report.md`

**Interfaces:**
- Consumes: exact provider/deployment evidence from Task 4.
- Produces: durable canonical-host documentation and a clean pushed branch.

- [ ] **Step 1: Replace temporary-host documentation with the verified canonical values**

Record `app.syntholo.com`, the exact WorkOS callback, Clerk DNS mode, Vercel/Railway service boundaries, deployment IDs, and verification timestamps. Do not record credentials.

- [ ] **Step 2: Run documentation and repository checks**

```bash
rg -n 'syntholo\.vercel\.app/__clerk|syntholo\.vercel\.app/v1/staff/auth/callback' docs .env.example
git diff --check
git status --short
```

Expected: no stale production identity endpoint remains in tracked documentation; only intended documentation changes are present.

- [ ] **Step 3: Commit and push**

```bash
git add docs/architecture/identity-and-sessions.md \
  docs/operations/foundation-deploy.md
git add -f .superpowers/sdd/2026-08-13-production-foundation/task-9-report.md
git commit -m "docs: record production domain cutover"
git push origin codex/production-platform
```

- [ ] **Step 4: Confirm final state**

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/codex/production-platform
```

Expected: clean worktree and matching local/remote SHA.
