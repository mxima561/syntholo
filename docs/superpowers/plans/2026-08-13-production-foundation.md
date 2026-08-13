# Production Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the production monorepo, typed API and worker runtimes, PostgreSQL/RLS data boundary, separate Clerk and WorkOS identity paths, durable audit/outbox primitives, and central entitlement authority without regressing the approved demo UI.

**Architecture:** Move the current Next.js app intact into `apps/web`, add a Fastify API and PostgreSQL job worker, and create framework-independent shared packages. Requests resolve a typed actor before use cases run; use cases mutate through scoped repositories; each transaction writes audit and outbox records; the entitlement evaluator is the only access authority.

**Tech Stack:** npm workspaces, Next.js 16.3, React 19.2, TypeScript 5.9, Fastify 5, Zod 4, Drizzle ORM, `pg`, Neon PostgreSQL, Clerk Backend SDK, WorkOS AuthKit/JWT, `jose`, Vitest, Playwright, and GitHub Actions.

## Global Constraints

- Preserve the current web routes, visuals, unit tests, Playwright baselines, and non-production demo behavior during the move.
- Production configuration rejects missing database/auth configuration and never falls back to demo repositories.
- `apps/web` has no database or privileged vendor secret; it calls the API through typed contracts.
- Member tokens and staff tokens use distinct verification functions, issuer/audience settings, Fastify hooks, and route prefixes.
- All customer-owned repositories require `accountId`; member-facing tables also have PostgreSQL RLS policies tested against a runtime role.
- Audit rows are append-only. Domain mutations and their outbox rows share one transaction.
- Entitlement evaluation is pure, deterministic, explainable, and independent from UI/provider SDKs.
- Business OS grants never gate Academy course access.
- Certificates are absent from entitlement types.
- Follow the master interfaces in `2026-08-13-production-program.md` exactly.

## Planned File Map

- `package.json`, `tsconfig.base.json` — workspace orchestration and common compiler contract.
- `apps/web/**` — mechanically relocated current application.
- `apps/api/src/app.ts`, `server.ts`, `config.ts` — API composition and startup.
- `apps/api/src/auth/{member,staff,authorize}.ts` — issuer-specific identity verification.
- `apps/worker/src/{runner,cron,config}.ts` — durable worker runtime.
- `packages/contracts/src/{http,health,identity}.ts` — stable Zod contracts.
- `packages/domain/src/identity/**` — actor and authorization rules.
- `packages/domain/src/entitlements/**` — grants, holds, seats, evaluator, state tests.
- `packages/database/src/{client,schema,unit-of-work}.ts` — database primitives.
- `packages/database/src/repositories/{audit,outbox,entitlements}.ts` — foundation repositories.
- `packages/database/drizzle/**` — versioned SQL migrations including roles and RLS.
- `packages/integrations/src/{clerk,workos}/**` — provider adapters.
- `packages/testing/src/**` — actors, database setup, and Fastify helpers.
- `.github/workflows/ci.yml`, `infra/railway/**` — foundation CI and service processes.

---

### Task 1: Convert the repository to npm workspaces without changing the web app

**Files:**
- Modify: `package.json`
- Create: `tsconfig.base.json`
- Create: `apps/web/package.json`
- Move: `src/**` → `apps/web/src/**`
- Move: `tests/**` → `apps/web/tests/**`
- Move: `next.config.ts`, `playwright.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `tsconfig.json` → `apps/web/`
- Modify: `apps/web/tsconfig.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces root scripts `dev:web`, `dev:api`, `dev:worker`, `lint`, `typecheck`, `test`, `test:integration`, `build`, and `test:e2e`.
- Preserves every current Next.js route and test import through `@/*` → `apps/web/src/*`.

- [ ] **Step 1: Record the pre-move route and test baseline**

Run:

```bash
npm run lint && npm run typecheck && npm test && npm run build
find src/app -name page.tsx -o -name route.ts | sort > /tmp/syntholo-routes-before.txt
```

Expected: all commands pass and the route inventory includes public, member, coach/admin, health, and Stripe webhook routes.

- [ ] **Step 2: Add a failing workspace smoke assertion**

Create `scripts/check-workspaces.mjs`:

```js
import { access } from "node:fs/promises";

await Promise.all([
  access(new URL("../apps/web/package.json", import.meta.url)),
  access(new URL("../apps/web/src/app/page.tsx", import.meta.url)),
  access(new URL("../apps/web/tsconfig.json", import.meta.url)),
]);
```

Run `node scripts/check-workspaces.mjs`.

Expected: FAIL with `ENOENT` because the workspaces do not exist.

- [ ] **Step 3: Move the web app and create the root workspace contract**

Set the root `package.json` to `private: true`, declare `workspaces: ["apps/*", "packages/*"]`, and use these scripts:

```json
{
  "scripts": {
    "dev:web": "npm run dev -w @syntholo/web",
    "dev:api": "npm run dev -w @syntholo/api",
    "dev:worker": "npm run dev -w @syntholo/worker",
    "lint": "npm run lint --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "test:integration": "npm run test:integration --workspaces --if-present",
    "build": "npm run build --workspaces --if-present",
    "test:e2e": "npm run test:e2e -w @syntholo/web"
  }
}
```

Move files with `git mv`, keep web dependencies in `apps/web/package.json`, and extend `../../tsconfig.base.json` from the web TypeScript config.

- [ ] **Step 4: Restore workspace dependencies and verify the move**

Run:

```bash
npm install
node scripts/check-workspaces.mjs
npm run lint && npm run typecheck && npm test && npm run build
find apps/web/src/app -name page.tsx -o -name route.ts | sed 's#apps/web/##' | sort > /tmp/syntholo-routes-after.txt
diff -u /tmp/syntholo-routes-before.txt /tmp/syntholo-routes-after.txt
```

Expected: checks pass; the only route-inventory difference is the `apps/web/` path prefix normalization.

- [ ] **Step 5: Commit the mechanical migration**

```bash
git add package.json package-lock.json tsconfig.base.json scripts apps/web
git commit -m "chore: migrate web app into workspaces"
```

### Task 2: Create shared contracts, domain, database, integrations, and testing packages

**Files:**
- Create: `packages/{contracts,domain,database,integrations,testing}/package.json`
- Create: `packages/{contracts,domain,database,integrations,testing}/tsconfig.json`
- Create: `packages/contracts/src/http.ts`
- Create: `packages/contracts/src/health.ts`
- Create: `packages/domain/src/identity/actor.ts`
- Create: `packages/testing/src/factories/actors.ts`
- Create: `packages/testing/src/{clock,fixtures}.ts`
- Create: `packages/contracts/src/http.test.ts`

**Interfaces:**
- Produces `@syntholo/contracts`, `@syntholo/domain`, `@syntholo/database`, `@syntholo/integrations`, `@syntholo/testing` through package exports.
- Produces `ApiErrorSchema`, `HealthResponseSchema`, `Actor`, `MemberActor`, and `StaffActor` exactly as defined by the master plan.
- Produces deterministic test helpers `day(offset): Date`, `hour(offset): Date`, `minute(offset): Date`, `memberActor(patch?)`, `staffActor(patch?)`, and domain fixture builders used in later plans.

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, it } from "vitest";
import { ApiErrorSchema } from "./http.js";

describe("ApiErrorSchema", () => {
  it("requires a safe code, UUID correlation id, and message", () => {
    expect(() => ApiErrorSchema.parse({ error: { code: "FORBIDDEN", message: "No access" } })).toThrow();
    expect(ApiErrorSchema.parse({
      error: {
        code: "FORBIDDEN",
        message: "No access",
        correlationId: "2c714c69-0b75-46ef-8141-739a72ec9689",
      },
    })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run RED**

Run `npm test -w @syntholo/contracts -- src/http.test.ts`.

Expected: FAIL because the package and schema do not exist.

- [ ] **Step 3: Add package exports and the exact schemas/types**

Use ESM exports from `./src/*.ts`; define `ApiErrorSchema` with Zod as shown in the master plan. Define `HealthResponseSchema` with `status: "ok" | "degraded"`, `releaseSha`, `service`, and dependency summaries that expose only state and latency.

```ts
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    correlationId: z.string().uuid(),
    details: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict();

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  releaseSha: z.string().min(1),
  service: z.enum(["web", "api", "worker"]),
  dependencies: z.array(z.object({ name: z.string(), status: z.enum(["ok", "degraded"]), latencyMs: z.number().nonnegative() })),
});
```

```ts
const TEST_EPOCH = new Date("2026-01-01T12:00:00.000Z");
export const minute = (offset: number) => new Date(TEST_EPOCH.getTime() + offset * 60_000);
export const hour = (offset: number) => minute(offset * 60);
export const day = (offset: number) => hour(offset * 24);

export const memberActor = (patch: Partial<MemberActor> = {}): MemberActor => ({
  kind: "member", actorId: "actor_member", clerkUserId: "user_member", accountId: "account_1",
  membershipId: "membership_1", role: "owner", authenticatedAt: TEST_EPOCH, ...patch,
});
```

Install shared runtime/test dependencies in their owning workspaces:

```bash
npm install zod -w @syntholo/contracts
npm install --save-dev fast-check -w @syntholo/domain
```

- [ ] **Step 4: Run GREEN and workspace checks**

Run `npm test -w @syntholo/contracts && npm run typecheck`.

Expected: PASS with no cross-package source-import errors.

- [ ] **Step 5: Commit**

```bash
git add packages package.json package-lock.json
git commit -m "feat: add production shared packages"
```

### Task 3: Add PostgreSQL configuration, base schema, migrations, and integration harness

**Files:**
- Create: `packages/database/drizzle.config.ts`
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/schema/{identity,operations}.ts`
- Create: `packages/database/src/schema/index.ts`
- Create: `packages/database/src/unit-of-work.ts`
- Create: `packages/database/drizzle/0001_foundation.sql`
- Create: `packages/testing/src/database.ts`
- Create: `infra/docker-compose.test.yml`
- Create: `packages/database/src/schema/foundation.integration.test.ts`

**Interfaces:**
- Produces `createDatabase(config): Database`, `UnitOfWork.transaction`, and `withAccountScope` from the master plan.
- Produces tables `accounts`, `member_identities`, `memberships`, `staff_identities`, `audit_events`, `outbox_events`, `jobs`, and `provider_event_receipts`.
- Consumes `TEST_DATABASE_URL` for integration tests; never silently uses `DATABASE_URL` in tests.

- [ ] **Step 1: Write a failing migration integration test**

```ts
it("enforces provider identity and event uniqueness", async () => {
  const accountId = await factories.account(db);
  await factories.memberIdentity(db, { accountId, provider: "clerk", providerUserId: "user_1" });
  await expect(factories.memberIdentity(db, { accountId, provider: "clerk", providerUserId: "user_1" }))
    .rejects.toMatchObject({ code: "23505" });
  await factories.providerReceipt(db, { provider: "stripe", eventId: "evt_1" });
  await expect(factories.providerReceipt(db, { provider: "stripe", eventId: "evt_1" }))
    .rejects.toMatchObject({ code: "23505" });
});
```

- [ ] **Step 2: Start the disposable database and run RED**

```bash
docker compose -f infra/docker-compose.test.yml up -d postgres
TEST_DATABASE_URL=postgres://syntholo:syntholo@localhost:55432/syntholo_test npm run test:integration -w @syntholo/database
```

Expected: FAIL because the migration and tables do not exist.

- [ ] **Step 3: Implement schema and transaction primitives**

Use UUID primary keys, `timestamptz`, immutable `account_id`, JSONB event payloads, unique `(provider, provider_event_id)`, and indexed outbox/job claim columns. `createDatabase` must require an explicit URL and set `application_name`.

```bash
npm install pg drizzle-orm -w @syntholo/database
npm install --save-dev drizzle-kit @types/pg -w @syntholo/database
```

```ts
export function createDatabase(config: { url: string; applicationName: string }): Database {
  if (!config.url) throw new Error("DATABASE_URL_REQUIRED");
  const pool = new Pool({ connectionString: config.url, application_name: config.applicationName });
  return drizzle(pool, { schema });
}

export const providerEventReceipts = pgTable("provider_event_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  status: text("status").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.provider, table.providerEventId)]);
```

- [ ] **Step 4: Apply migrations and run GREEN**

```bash
TEST_DATABASE_URL=postgres://syntholo:syntholo@localhost:55432/syntholo_test npm run db:migrate -w @syntholo/database
TEST_DATABASE_URL=postgres://syntholo:syntholo@localhost:55432/syntholo_test npm run test:integration -w @syntholo/database
```

Expected: PASS; a duplicate provider event returns PostgreSQL code `23505`.

- [ ] **Step 5: Commit**

```bash
git add packages/database packages/testing infra package.json package-lock.json
git commit -m "feat: add PostgreSQL foundation"
```

### Task 4: Enforce scoped repositories and PostgreSQL row-level security

**Files:**
- Create: `packages/database/drizzle/0002_roles_and_rls.sql`
- Create: `packages/database/src/repositories/accounts.ts`
- Create: `packages/database/src/rls.integration.test.ts`
- Create: `docs/architecture/database-access.md`

**Interfaces:**
- Produces `AccountRepository.getById(scope: { accountId: string }, id: string)`; no unscoped member-runtime read exists.
- Produces transaction setting `SET LOCAL app.account_id = $1` in `withAccountScope`.
- Produces roles `syntholo_migrator`, `syntholo_member_api`, `syntholo_staff_api`, and `syntholo_worker`; member tables are RLS-constrained, while staff cross-account access uses its own least-privilege pool and audited use cases.

- [ ] **Step 1: Write cross-account denial tests**

```ts
it("denies a member-runtime read outside the transaction account", async () => {
  const accountA = await factories.account(adminDb);
  const accountB = await factories.account(adminDb);
  const visible = await withAccountScope(apiDb, accountA, (tx) => tx.select().from(accounts));
  expect(visible.map((row) => row.id)).toEqual([accountA]);
  expect(visible).not.toContainEqual(expect.objectContaining({ id: accountB }));
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test:integration -w @syntholo/database -- src/rls.integration.test.ts`

Expected: the API role sees both accounts or the role/policy is missing.

- [ ] **Step 3: Add roles, policies, and scoped repository signatures**

Enable and force RLS on each customer-owned foundation table. Use `current_setting('app.account_id', true)::uuid`; deny when unset. Grant `syntholo_member_api` only scoped runtime CRUD, grant `syntholo_staff_api` only staff-use-case operations, and keep worker access explicit and audited.

```sql
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY accounts_member_scope ON accounts
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
```

```ts
export async function withAccountScope<T>(db: Database, accountId: string, run: (tx: DatabaseTransaction) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
    return run(tx);
  });
}
```

- [ ] **Step 4: Run GREEN plus a missing-scope test**

Run `npm run test:integration -w @syntholo/database -- src/rls.integration.test.ts`.

Expected: account A sees only A; account B sees only B; an unset account scope returns no rows and cannot insert.

- [ ] **Step 5: Commit**

```bash
git add packages/database docs/architecture/database-access.md
git commit -m "feat: enforce account-scoped PostgreSQL access"
```

### Task 5: Build the Fastify API and worker health runtimes

**Files:**
- Create: `apps/api/package.json`, `tsconfig.json`
- Create: `apps/api/src/{app,server,config}.ts`
- Create: `apps/api/src/plugins/{context,error-handler}.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/app.test.ts`
- Create: `apps/worker/package.json`, `tsconfig.json`
- Create: `apps/worker/src/{runner,cron,config}.ts`
- Create: `apps/worker/src/runner.test.ts`

**Interfaces:**
- Produces `buildApp(dependencies): FastifyInstance` for injection tests.
- Produces `GET /v1/health/live` and `GET /v1/health/ready` matching `HealthResponseSchema`.
- Adds `request.context: RequestContext` with a generated or validated `x-correlation-id`.
- Produces typed `AppError(code, status, safeMessage, details?)`; stack traces/provider payloads are never serialized.

- [ ] **Step 1: Write failing health/error tests**

```ts
it("returns release identity and a correlation id", async () => {
  const response = await buildApp(fakes()).inject({ method: "GET", url: "/v1/health/live" });
  expect(response.statusCode).toBe(200);
  expect(response.headers["x-correlation-id"]).toMatch(/[0-9a-f-]{36}/);
  expect(response.json()).toMatchObject({ status: "ok", service: "api", releaseSha: "test" });
});
```

- [ ] **Step 2: Run RED**

Run `npm test -w @syntholo/api` and `npm test -w @syntholo/worker`.

Expected: FAIL because both runtimes are absent.

- [ ] **Step 3: Implement config, Fastify composition, safe errors, and worker loop**

Validate environment through Zod. The worker claims no job without `DATABASE_URL`, `RELEASE_SHA`, and `WORKER_CONCURRENCY`. In production, any missing required configuration exits non-zero before listening.

```ts
export async function buildApp(deps: ApiDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger, genReqId: () => randomUUID() });
  await app.register(requestContextPlugin);
  await app.register(healthRoutes, { prefix: "/v1/health", dependencies: deps.health });
  app.setErrorHandler(safeErrorHandler);
  return app;
}

export async function runWorker(deps: WorkerDependencies, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const jobs = await deps.jobs.claim(deps.config.concurrency, deps.workerId, deps.clock.now());
    await Promise.all(jobs.map((job) => deps.handlers.handle(job)));
  }
}
```

Install the API/worker runtime dependencies, including route-scoped raw bodies for signed provider webhooks:

```bash
npm install fastify fastify-plugin fastify-raw-body zod -w @syntholo/api
```

- [ ] **Step 4: Run GREEN and startup smoke tests**

```bash
npm test -w @syntholo/api
npm test -w @syntholo/worker
npm run build -w @syntholo/api
npm run build -w @syntholo/worker
```

Expected: PASS; health contains no secret values.

- [ ] **Step 5: Commit**

```bash
git add apps/api apps/worker package.json package-lock.json
git commit -m "feat: add API and worker runtimes"
```

### Task 6: Implement separate Clerk member and WorkOS staff authentication

**Files:**
- Create: `packages/integrations/src/clerk/client.ts`
- Create: `packages/integrations/src/workos/jwt.ts`
- Create: `packages/database/src/schema/staff-sessions.ts`
- Create: `packages/database/src/repositories/staff-sessions.ts`
- Create: `packages/database/drizzle/0003_staff_sessions.sql`
- Create: `apps/api/src/auth/{member,staff,authorize}.ts`
- Create: `apps/api/src/routes/staff/auth.ts`
- Create: `apps/api/src/routes/{member,staff}/whoami.ts`
- Create: `apps/api/src/auth/auth.integration.test.ts`
- Create: `apps/web/src/lib/api/{client,member-token,staff-session}.ts`
- Create: `apps/web/src/app/sign-in/[[...sign-in]]/page.tsx`
- Create: `apps/web/src/app/sign-up/[[...sign-up]]/page.tsx`
- Delete: `apps/web/src/lib/integrations/workos.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/web/src/app/admin/layout.tsx`

**Interfaces:**
- Consumes Clerk `authenticateRequest(request, { authorizedParties, audience })` and maps only verified `userId` to `MemberActor` through the database.
- Consumes WorkOS access JWT through `jose.jwtVerify` with configured JWKS and issuer; validates documented `client_id` exactly without inventing an OAuth audience, plus organization, session, singleton role, permissions, `iat`, and `auth_time`.
- Produces API-owned `GET /v1/staff/auth/sign-in`, `GET /v1/staff/auth/callback`, and `POST /v1/staff/auth/sign-out` behind the canonical origin's external `/v1` rewrite. The API exchanges the WorkOS code, stores encrypted access/refresh tokens in `staff_sessions`, and sets only a hashed-lookup opaque ID in a production host-only `__Host-syntholo_staff_session` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`). Local development uses a distinct unprefixed non-Secure cookie.
- `staff_sessions` stores SHA-256 session lookup, AES-256-GCM token ciphertext/IV/tag, key version, expiry, revocation time, WorkOS session ID, and staff ID. `STAFF_SESSION_ENCRYPTION_KEYS` exists only in the API secret store; sign-out revokes the row and WorkOS session.
- Produces hooks `requireMember`, `requireCoach`, `requireAdmin`, and `requireRecentAuth(actor, maxAgeSeconds)`.

- [ ] **Step 1: Write the issuer-confusion tests**

```ts
it.each([
  ["Clerk token", clerkToken(), "/v1/staff/whoami"],
  ["WorkOS token", workosToken({ role: "admin" }), "/v1/member/whoami"],
])("rejects %s on the wrong surface", async (_label, token, url) => {
  const response = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
  expect(response.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/api -- src/auth/auth.integration.test.ts`

Expected: routes or verifiers do not exist.

- [ ] **Step 3: Implement provider adapters and actor lookup**

Use Clerk's official backend verification with bearer-only `session_token`, explicit authorized parties and audience. Verify WorkOS JWT signature, `iss`, documented `client_id`, organization, `auth_time`, expiration, and exact role/permissions. Do not require an undocumented WorkOS `aud`. Never accept provider claims as internal `accountId` or `staffId`; resolve the internal mapping from PostgreSQL.

```ts
export async function verifyMember(request: Request, deps: MemberAuthDependencies): Promise<MemberActor> {
  const state = await deps.clerk.authenticateRequest(request, {
    authorizedParties: deps.authorizedParties,
    audience: deps.audience,
  });
  if (!state.isAuthenticated) throw new AppError("UNAUTHENTICATED", 401, "Sign in required");
  return deps.identities.findMemberActorByClerkUserId(state.toAuth().userId);
}

export async function verifyStaff(token: string, deps: StaffAuthDependencies): Promise<StaffActor> {
  const { payload } = await jwtVerify(token, deps.jwks, { issuer: deps.issuer });
  if (payload.client_id !== deps.clientId) throw new AppError("UNAUTHENTICATED", 401, "Sign in required");
  return deps.identities.findStaffActorByWorkosUserId(String(payload.sub), payload.role, payload.permissions);
}
```

```ts
export async function workosCallback(request: FastifyRequest, reply: FastifyReply, deps: WorkosAuthDependencies) {
  const loginAttempt = await deps.loginState.consumeAndVerify(callbackState(request), request.cookies.staff_login_state);
  const tokens = await deps.workos.authenticateWithCode({
    code: callbackCode(request), clientId: deps.clientId, codeVerifier: loginAttempt.codeVerifier,
  });
  const session = await deps.staffSessions.createEncrypted(tokens, deps.clock.now());
  reply.setCookie(deps.cookieName, session.rawCookieId, {
    path: "/", httpOnly: true, secure: deps.environment !== "local", sameSite: "lax", maxAge: session.maxAgeSeconds,
  });
  return reply.redirect(deps.staffHomeUrl);
}
```

Remove `@workos-inc/authkit-nextjs` and the web WorkOS integration stub; install the official WorkOS Node SDK in `@syntholo/integrations`. The web's staff client sends relative same-origin requests and never reads the cookie/token.

```bash
npm uninstall @workos-inc/authkit-nextjs -w @syntholo/web
npm install @clerk/nextjs -w @syntholo/web
npm install @clerk/backend @workos-inc/node jose -w @syntholo/integrations
```

- [ ] **Step 4: Add authorization and recent-auth tests**

Cover anonymous, wrong issuer, expired token, unknown internal identity, teammate on owner-only action, coach on admin action, missing permission, and stale authentication.

```ts
it.each([
  [memberActor({ role: "teammate" }), { role: "owner" }, "FORBIDDEN"],
  [staffActor({ role: "coach" }), { role: "admin" }, "FORBIDDEN"],
  [staffActor({ role: "admin", permissions: [] }), { permission: "content:publish" }, "FORBIDDEN"],
])("denies actor outside the route authorization", (actor, requirement, code) => {
  try {
    authorize(actor, requirement);
    expect.unreachable("authorization should fail");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
});

it("requires authentication in the last five minutes", () => {
  expect(() => requireRecentAuth(staffActor({ authenticatedAt: minute(-6) }), 300)).toThrow("RECENT_AUTH_REQUIRED");
});
```

- [ ] **Step 5: Run GREEN**

```bash
npm test -w @syntholo/api -- src/auth/auth.integration.test.ts
npm run typecheck
```

Expected: all allow and deny cases pass; no route accepts both issuers.

- [ ] **Step 6: Commit**

```bash
git add apps/api apps/web packages/integrations packages/testing package.json package-lock.json
git commit -m "feat: separate member and staff authentication"
```

### Task 7: Add append-only audit and durable outbox/job processing

**Files:**
- Create: `packages/database/src/repositories/{audit,outbox,jobs}.ts`
- Create: `packages/domain/src/events.ts`
- Create: `apps/worker/src/handlers/index.ts`
- Create: `apps/worker/src/jobs.integration.test.ts`
- Create: `apps/api/src/modules/foundation/mutate-with-event.ts`
- Create: `apps/api/src/modules/foundation/mutate-with-event.integration.test.ts`

**Interfaces:**
- Produces `AuditRepository.append(tx, event)` with no update/delete methods.
- Produces `OutboxRepository.enqueue(tx, DomainEvent)` and `JobRepository.claim(batchSize, workerId, now)` using `FOR UPDATE SKIP LOCKED`.
- Retry schedule is bounded exponential backoff with jitter; exhausted jobs become `dead_letter` and retain attempts/error code.

- [ ] **Step 1: Write atomicity and concurrent-claim tests**

Test that a failed mutation writes neither audit nor outbox, a committed mutation writes both, and two workers never claim the same job.

```ts
it("claims each job once across workers", async () => {
  await factories.jobs(db, 10);
  const [a, b] = await Promise.all([
    jobs.claim(10, "worker-a", now),
    jobs.claim(10, "worker-b", now),
  ]);
  expect(new Set([...a, ...b].map((job) => job.id)).size).toBe(10);
});

it("rolls back audit and outbox with the mutation", async () => {
  await expect(mutateWithEvent(uow, async (tx) => {
    await tx.audit.append(auditFixture());
    await tx.outbox.enqueue(eventFixture());
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect(await counts(db, ["audit_events", "outbox_events"])).toEqual([0, 0]);
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test:integration -w @syntholo/worker -- src/jobs.integration.test.ts && npm run test:integration -w @syntholo/api -- mutate-with-event.integration.test.ts`

Expected: repositories are missing.

- [ ] **Step 3: Implement append, enqueue, claim, complete, retry, and dead-letter**

Store safe error code/message only; reject mutation of an audit row with a database trigger. Event handler completion uses unique `(handler_name, event_id)` delivery receipts.

```ts
export async function claimJobs(tx: DatabaseTransaction, limit: number, workerId: string, now: Date) {
  return tx.execute(sql`
    update jobs set status = 'running', worker_id = ${workerId}, claimed_at = ${now}
    where id in (
      select id from jobs where status = 'queued' and run_at <= ${now}
      order by priority desc, run_at asc for update skip locked limit ${limit}
    ) returning *
  `);
}

export function nextAttempt(attempt: number, now: Date): Date {
  return new Date(now.getTime() + Math.min(3_600_000, 1_000 * 2 ** attempt));
}
```

- [ ] **Step 4: Run GREEN under concurrency**

Run: `npm run test:integration -w @syntholo/worker -- src/jobs.integration.test.ts && npm run test:integration -w @syntholo/api -- mutate-with-event.integration.test.ts`

Expected: PASS with 10 unique claims across two workers, atomic audit/outbox rollback, and one exhausted dead-letter job.

- [ ] **Step 5: Commit**

```bash
git add apps/api apps/worker packages/database packages/domain
git commit -m "feat: add audit and durable job primitives"
```

### Task 8: Implement the entitlement authority and seat invariants

**Files:**
- Create: `packages/domain/src/entitlements/{types,evaluate,transitions}.ts`
- Create: `packages/domain/src/entitlements/{evaluate,transitions}.test.ts`
- Create: `packages/domain/src/entitlements/evaluate.property.test.ts`
- Modify: `packages/domain/package.json`
- Create: `packages/database/src/schema/entitlements.ts`
- Create: `packages/database/src/repositories/entitlements.ts`
- Create: `packages/database/drizzle/0004_entitlements.sql`
- Create: `packages/database/src/entitlements.integration.test.ts`
- Create: `apps/api/src/modules/entitlements/get-effective-access.ts`
- Create: `apps/api/src/routes/member/access.ts`

**Interfaces:**
- Produces the exact `GrantCapability`, `GrantStatus`, `HoldKind`, `EffectiveAccess`, and `evaluateEntitlements` signatures from the master plan.
- Produces tables `entitlement_grants`, `account_holds`, `seat_reservations`, and `access_decision_audit`.
- Enforces at most three `pending | active` seat reservations per paid Academy source account and seven-day pending invitation expiry.

- [ ] **Step 1: Write the pure-rule RED matrix**

```ts
it("keeps lifetime course access after support expiry", () => {
  const result = evaluateEntitlements(fixture({ now: day(366), academyPurchaseAt: day(0) }));
  expect(result.capabilities.academy_course).toBe(true);
  expect(result.capabilities.support).toBe(false);
  expect(result.capabilities.circle_write).toBe(false);
});

it("never lets Business OS state gate Academy", () => {
  const result = evaluateEntitlements(fixture({ academy: "active", businessOs: "revoked" }));
  expect(result.capabilities.academy_course).toBe(true);
  expect(result.capabilities.business_os).toBe(false);
});
```

Add cases for active, grace, expired, refunded, revoked, overlapping grants, early Operator Club schedule, dispute holds, three seats, invitation expiry, and no certificate capability.

Add a `fast-check` property that no Business OS-only grant combination can produce Academy access:

```ts
it("never derives Academy from Business OS grants", () => {
  fc.assert(fc.property(fc.array(businessOsGrantArbitrary), (grants) => {
    const access = evaluateEntitlements(fixture({ grants }));
    expect(access.capabilities.academy_course).toBe(false);
  }));
});
```

- [ ] **Step 2: Run RED**

Run `npm test -w @syntholo/domain -- src/entitlements`.

Expected: FAIL because the authority does not exist.

- [ ] **Step 3: Implement the pure evaluator and transitions**

Sort active sources deterministically, compute each capability independently, preserve source grant IDs in explanations, apply holds only to their named mutation domains, and return frozen/read-only data.

```ts
export function evaluateEntitlements(input: EntitlementEvaluationInput): EffectiveAccess {
  const usable = input.grants.filter((grant) => grant.status === "active" || grant.status === "grace");
  const sources = (capability: GrantCapability) => usable
    .filter((grant) => grant.capability === capability && grant.startsAt <= input.now && (!grant.endsAt || grant.endsAt > input.now))
    .map((grant) => grant.id).sort();
  const capabilities = Object.fromEntries(CAPABILITIES.map((capability) => [capability, sources(capability).length > 0]));
  return Object.freeze({
    accountId: input.accountId,
    capabilities,
    holds: input.holds.filter((hold) => hold.active).map((hold) => hold.kind),
    seatLimit: 3,
    reservedSeats: input.seats.filter(isReserved).length,
    explanations: CAPABILITIES.map((capability) => ({ capability, sourceGrantIds: sources(capability) })),
  }) as EffectiveAccess;
}
```

- [ ] **Step 4: Add database constraint/race tests**

Attempt four concurrent seat reservations for one account; exactly three must commit. Verify duplicate source grants and invalid date ranges fail database constraints.

```ts
it("commits only three concurrent seat reservations", async () => {
  const results = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => reserveSeat(accountId, `member_${index}`)));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
  expect(await seats.countReserved(accountId)).toBe(3);
});

it("rejects an inverted grant interval", async () => {
  await expect(grants.insert({ ...grantFixture(), startsAt: day(2), endsAt: day(1) })).rejects.toMatchObject({ code: "23514" });
});
```

- [ ] **Step 5: Expose member access through the API**

`GET /v1/member/access` derives `accountId` only from `MemberActor`, loads grants/holds/seats, and returns the evaluator result. Never accept an account ID query parameter.

- [ ] **Step 6: Run GREEN and cross-role regressions**

```bash
npm test -w @syntholo/domain -- src/entitlements
npm run test:integration -w @syntholo/database -- src/entitlements.integration.test.ts
npm test -w @syntholo/api
npm run typecheck
```

Expected: PASS; no certificate type or Business OS coupling exists.

- [ ] **Step 7: Commit**

```bash
git add apps/api packages/domain packages/database packages/contracts
git commit -m "feat: centralize account entitlements"
```

### Task 9: Add foundation CI, deploy processes, and gate evidence

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `infra/railway/api.toml`
- Create: `infra/railway/worker.toml`
- Create: `apps/api/Dockerfile`
- Create: `apps/worker/Dockerfile`
- Create: `docs/operations/foundation-deploy.md`
- Create: `infra/scripts/gate-foundation.mjs`
- Delete: `apps/web/src/lib/integrations/mongodb.ts`
- Delete: `apps/web/src/lib/integrations/highlevel.ts`
- Delete: `apps/web/src/lib/integrations/stripe.ts`
- Delete: `apps/web/src/lib/integrations/mux.ts`
- Delete: `apps/web/src/lib/integrations/resend.ts`
- Delete: `apps/web/src/lib/integrations/blob.ts`
- Delete: `apps/web/src/lib/integrations/contracts.ts`
- Delete: `apps/web/src/app/api/webhooks/stripe/route.ts`
- Delete: `apps/web/src/app/api/webhooks/stripe/route.test.ts`
- Modify: `apps/web/src/lib/config/env.ts`
- Modify: `apps/web/src/lib/config/env.test.ts`
- Modify: `apps/web/src/app/api/health/route.ts`
- Modify: `apps/web/package.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces immutable `RELEASE_SHA` in API/worker health and web build metadata.
- Produces `npm run gate:foundation`, which checks workspace builds, migrations, RLS denial, identity separation, job concurrency, and entitlement invariants.

- [ ] **Step 1: Write the failing gate script test**

Add a Vitest test that executes the gate script with missing `RELEASE_SHA` and expects non-zero, then with test configuration and expects each named check in JSON output.

```ts
it("blocks the foundation gate without release identity", async () => {
  const result = await runGate({ RELEASE_SHA: "" });
  expect(result.exitCode).toBe(1);
  expect(result.json.checks.releaseSha).toEqual({ status: "BLOCKED", reason: "RELEASE_SHA_REQUIRED" });
});

it("reports every foundation check", async () => {
  const result = await runGate(testEnvironment());
  expect(Object.keys(result.json.checks)).toEqual(expect.arrayContaining([
    "workspaces", "migrations", "rls", "identitySeparation", "jobs", "entitlements", "releaseSha",
  ]));
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/testing -- gate-foundation.test.ts`

Expected: the script and deploy files are missing.

- [ ] **Step 3: Add CI jobs and independently buildable service images**

CI starts PostgreSQL, installs with `npm ci`, runs lint/typecheck/unit/integration/build, and uploads test reports. Docker images run as non-root users and use API `server.js`, worker `runner.js`, and worker `cron.js` as explicit processes.

```yaml
jobs:
  foundation:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env: { POSTGRES_PASSWORD: syntholo, POSTGRES_DB: syntholo_test }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run gate:foundation
```

- [ ] **Step 4: Remove MongoDB and the forbidden HighLevel connection from the production dependency graph**

```ts
it("contains no MongoDB runtime package or import", async () => {
  const graph = await inspectProductionDependencyGraph(repositoryRoot);
  expect(graph.packages).not.toContain("mongodb");
  expect(graph.imports.filter((item) => item.specifier.includes("mongodb"))).toEqual([]);
});

it("contains no HighLevel credential or API connection", async () => {
  const graph = await inspectProductionDependencyGraph(repositoryRoot);
  expect(graph.environmentKeys).not.toContain("HIGHLEVEL_API_KEY");
  expect(graph.urls.some((url) => /leadconnectorhq|gohighlevel/.test(url))).toBe(false);
});
```

Delete both obsolete adapters, remove MongoDB/HighLevel parsing from the web environment contract, reduce the web health route to `{ service: "web", releaseSha, status }`, add both dependency-graph assertions to `gate:foundation`, then run:

```ts
export const WebEnvironmentSchema = z.object({
  APP_MODE: z.enum(["demo", "production"]).default("demo"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().startsWith("pk_").optional(),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional(),
}).passthrough().superRefine((value, context) => {
  if (value.APP_MODE === "production" && !value.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    context.addIssue({ code: "custom", path: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"], message: "Clerk is required in production" });
  }
});
```

Remove every privileged vendor adapter and the Stripe write route from `apps/web`; later focused plans create their production adapters only in `packages/integrations` and write routes only in `apps/api`.

```bash
npm uninstall mongodb -w @syntholo/web
npm uninstall stripe resend -w @syntholo/web
```

- [ ] **Step 5: Run the complete foundation gate**

```bash
npm run gate:foundation
docker build -f apps/api/Dockerfile .
docker build -f apps/worker/Dockerfile .
git diff --check
```

Expected: Gate 1 reports `PASS`; images build; production startup fails closed when a required secret is removed.

- [ ] **Step 6: Self-review**

Confirm: no MongoDB dependency in production packages, no privileged secret in web env, no dual-provider route, no unscoped member repository, no certificate entitlement, and no HighLevel API integration.

- [ ] **Step 7: Commit**

```bash
git add .github infra apps packages docs/operations package.json package-lock.json
git commit -m "ci: verify production foundation gate"
```
