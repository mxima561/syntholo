import { randomUUID } from "node:crypto";
import {
  AccountRepository,
  createDatabase,
  MemberEntitlementReadRepository,
  MemberIdentityRepository,
  type Database,
} from "@syntholo/database";
import { createTestDatabaseHarness, type TestDatabaseHarness } from "@syntholo/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type ApiDependencies } from "../../app.js";
import type { AuthRouteDependencies } from "../../auth/types.js";

const accountA = "a0000000-0000-4000-8000-000000000001";
const accountB = "b0000000-0000-4000-8000-000000000002";
const identityA = "a0000000-0000-4000-8000-000000000011";
const identityB = "b0000000-0000-4000-8000-000000000012";
const membershipA = "a0000000-0000-4000-8000-000000000021";
const membershipB = "b0000000-0000-4000-8000-000000000022";

type RuntimeLogin = Readonly<{
  database: Database;
  password: string;
  roleName: string;
}>;

function loginUrl(baseUrl: string, roleName: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  url.search = "";
  return url.toString();
}

async function formatted(
  database: Database,
  template: string,
  values: string[],
): Promise<string> {
  const parameters = values.map((_, index) => `$${index + 1}::text`).join(",");
  const result = await database.pool.query<{ statement: string }>(
    `select format($format$${template}$format$,${parameters}) statement`,
    values,
  );
  const statement = result.rows[0]?.statement;
  if (statement === undefined) throw new Error("TEST_SQL_FORMAT_FAILED");
  return statement;
}

async function createMemberLogin(owner: Database, baseUrl: string): Promise<RuntimeLogin> {
  const roleName = `syntholo_api_dashboard_${process.pid}`;
  const password = randomUUID();
  await owner.pool.query(await formatted(
    owner,
    "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
    [roleName, password],
  ));
  await owner.pool.query(await formatted(
    owner,
    "grant syntholo_member_api to %I with inherit true, set false, admin false",
    [roleName],
  ));
  return {
    database: createDatabase({
      applicationName: "syntholo-api-dashboard-integration",
      url: loginUrl(baseUrl, roleName, password),
    }),
    password,
    roleName,
  };
}

async function dropMemberLogin(owner: Database, login: RuntimeLogin): Promise<void> {
  await login.database.close();
  await owner.pool.query(await formatted(
    owner,
    "revoke syntholo_member_api from %I",
    [login.roleName],
  ));
  await owner.pool.query(await formatted(owner, "drop role if exists %I", [login.roleName]));
}

function staffDependencies(): AuthRouteDependencies["staff"] {
  return {
    config: {
      environment: "test",
      webOrigin: "https://app.syntholo.test",
      clientId: "unused",
      organizationId: "unused",
      callbackUrl: "https://app.syntholo.test/v1/staff/auth/callback",
      defaultReturnTo: "/admin",
      allowedReturnToPrefixes: ["/admin"],
      sessionHardTtlSeconds: 3600,
      loginAttemptTtlSeconds: 300,
      refreshLeaseSeconds: 5,
    },
    clock: { now: () => new Date("2026-08-14T20:00:00.000Z") },
    sessionCrypto: {} as AuthRouteDependencies["staff"]["sessionCrypto"],
    loginAttempts: {} as AuthRouteDependencies["staff"]["loginAttempts"],
    sessions: {} as AuthRouteDependencies["staff"]["sessions"],
    identities: {} as AuthRouteDependencies["staff"]["identities"],
    tokens: {} as AuthRouteDependencies["staff"]["tokens"],
    workos: {} as AuthRouteDependencies["staff"]["workos"],
    sleep: async () => undefined,
  };
}

function apiDependencies(input: Readonly<{
  memberDatabase: Database;
  accounts?: NonNullable<AuthRouteDependencies["member"]["dashboard"]>["accounts"];
}>): ApiDependencies {
  const accounts = input.accounts ?? new AccountRepository(input.memberDatabase);
  const member: AuthRouteDependencies["member"] = {
    webOrigin: "https://app.syntholo.test",
    audience: "syntholo-member-api",
    authorizedParties: ["https://app.syntholo.test"],
    clerk: {
      authenticateRequest: async (request) => {
        const token = request.headers.get("authorization");
        const userId = token === "Bearer token-a"
          ? "clerk_user_a"
          : token === "Bearer token-b" ? "clerk_user_b" : null;
        return userId === null ? null : {
          userId,
          firstFactorVerifiedAt: new Date("2026-08-14T19:59:00.000Z"),
          authorizedParty: "https://app.syntholo.test",
        };
      },
    },
    identities: new MemberIdentityRepository(input.memberDatabase),
    access: new MemberEntitlementReadRepository(input.memberDatabase, {
      now: () => new Date("2026-08-14T20:00:00.000Z"),
    }),
    dashboard: {
      accounts,
      clock: { now: () => new Date("2026-08-14T20:00:00.123Z") },
    },
  };
  return {
    releaseSha: "1111111111111111111111111111111111111111",
    health: { dependencies: [] },
    auth: { kind: "enabled", dependencies: { member, staff: staffDependencies() } },
  };
}

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => { resolve = settled; });
  return { promise, resolve };
}

describe.sequential("production member dashboard over the real member role", () => {
  let harness: TestDatabaseHarness;
  let login: RuntimeLogin;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    login = await createMemberLogin(harness.database, baseUrl);
  });

  beforeEach(async () => {
    await harness.reset();
    await harness.database.pool.query(
      "insert into accounts(id,name) values($1,'Account A'),($2,'Account B')",
      [accountA, accountB],
    );
    await harness.database.pool.query(
      `insert into member_identities(id,account_id,provider,provider_user_id)
       values($3,$1,'clerk','clerk_user_a'),($4,$2,'clerk','clerk_user_b')`,
      [accountA, accountB, identityA, identityB],
    );
    await harness.database.pool.query(
      `insert into memberships(id,account_id,member_identity_id,role)
       values($5,$1,$3,'owner'),($6,$2,$4,'owner')`,
      [accountA, accountB, identityA, identityB, membershipA, membershipB],
    );
  });

  afterAll(async () => {
    if (login !== undefined) await dropMemberLogin(harness.database, login);
    await harness?.close();
  });

  it("keeps A/B names isolated and performs no mutation through the real API path", async () => {
    const before = await harness.database.pool.query(
      "select id,name,status,updated_at from accounts order by id",
    );
    const app = await buildApp(apiDependencies({ memberDatabase: login.database }));
    const [a, b] = await Promise.all([
      app.inject({ method: "GET", url: "/v1/member/dashboard", headers: { authorization: "Bearer token-a" } }),
      app.inject({ method: "GET", url: "/v1/member/dashboard", headers: { authorization: "Bearer token-b" } }),
    ]);

    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ account: { id: accountA, name: "Account A" } });
    expect(a.payload).not.toContain("Account B");
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ account: { id: accountB, name: "Account B" } });
    expect(b.payload).not.toContain("Account A");
    await expect(harness.database.pool.query(
      "select id,name,status,updated_at from accounts order by id",
    )).resolves.toMatchObject({ rows: before.rows });
    await app.close();
  });

  it.each(["account", "membership"] as const)(
    "serializes no account name when a %s denial commits after the informational read but before final access",
    async (kind) => {
      const read = deferred();
      const proceed = deferred();
      const realAccounts = new AccountRepository(login.database);
      const accounts: NonNullable<AuthRouteDependencies["member"]["dashboard"]>["accounts"] = {
        getById: async (...args) => {
          const account = await realAccounts.getById(...args);
          read.resolve();
          await proceed.promise;
          return account;
        },
      };
      const app = await buildApp(apiDependencies({ memberDatabase: login.database, accounts }));
      const response = app.inject({
        method: "GET",
        url: "/v1/member/dashboard",
        headers: { authorization: "Bearer token-a" },
      });
      await read.promise;
      await harness.database.pool.query(
        kind === "account"
          ? "update accounts set status='suspended' where id=$1"
          : "update memberships set status='revoked' where id=$1",
        [kind === "account" ? accountA : membershipA],
      );
      proceed.resolve();

      const denied = await response;
      expect(denied.statusCode).toBe(401);
      expect(denied.payload).not.toContain("Account A");
      expect(denied.payload).not.toContain(accountA);
      await app.close();
    },
  );

  it.each(["account", "membership"] as const)(
    "linearizes a completed dashboard read before a following %s denial and rejects the next request",
    async (kind) => {
      const app = await buildApp(apiDependencies({ memberDatabase: login.database }));
      const before = await app.inject({
        method: "GET",
        url: "/v1/member/dashboard",
        headers: { authorization: "Bearer token-a" },
      });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toMatchObject({ account: { name: "Account A" } });

      await harness.database.pool.query(
        kind === "account"
          ? "update accounts set status='suspended' where id=$1"
          : "update memberships set status='revoked' where id=$1",
        [kind === "account" ? accountA : membershipA],
      );
      const after = await app.inject({
        method: "GET",
        url: "/v1/member/dashboard",
        headers: { authorization: "Bearer token-a" },
      });
      expect(after.statusCode).toBe(401);
      expect(after.payload).not.toContain("Account A");
      await app.close();
    },
  );
});
