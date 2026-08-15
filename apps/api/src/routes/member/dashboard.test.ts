import type { EffectiveAccess, MemberActor } from "@syntholo/domain";
import {
  DatabaseDependencyUnavailableError,
  MemberAccessUnavailableError,
} from "@syntholo/database";
import { MemberDashboardResponseSchema } from "@syntholo/contracts/member-dashboard";
import { memberActor } from "@syntholo/testing";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type ApiDependencies } from "../../app.js";
import type { AuthRouteDependencies } from "../../auth/types.js";

const now = new Date("2026-08-14T16:00:00.123Z");
const actor = memberActor({
  actorId: "10000000-0000-4000-8000-000000000011",
  accountId: "10000000-0000-4000-8000-000000000001",
  membershipId: "10000000-0000-4000-8000-000000000021",
  clerkUserId: "clerk_dashboard",
  authenticatedAt: now,
});

function access(academyCourse = true): EffectiveAccess {
  return {
    accountId: actor.accountId,
    capabilities: {
      academy_course: academyCourse,
      support: false,
      circle_write: false,
      operator_club: false,
      business_os: false,
    },
    holds: [],
    seatLimit: 3,
    reservedSeats: 1,
    explanations: [
      { capability: "academy_course", sourceGrantIds: academyCourse
        ? ["10000000-0000-4000-8000-000000000031"] : [] },
      { capability: "support", sourceGrantIds: [] },
      { capability: "circle_write", sourceGrantIds: [] },
      { capability: "operator_club", sourceGrantIds: [] },
      { capability: "business_os", sourceGrantIds: [] },
    ],
  };
}

function dependencies(input: {
  account?: () => Promise<unknown>;
  effectiveAccess?: (actor: MemberActor) => Promise<unknown>;
  authenticate?: () => Promise<unknown>;
  clock?: () => Date;
} = {}) {
  const events: string[] = [];
  const authenticateRequest = vi.fn(async () => {
    events.push("authenticate");
    return input.authenticate?.() ?? {
      userId: actor.clerkUserId,
      firstFactorVerifiedAt: actor.authenticatedAt,
      authorizedParty: "https://app.syntholo.test",
    };
  });
  const getById = vi.fn(async () => {
    events.push("account");
    return input.account?.() ?? {
      id: actor.accountId,
      name: "Acme Advisory",
      status: "active",
      ownerEstablishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  });
  const getEffectiveAccess = vi.fn(async (member: MemberActor) => {
    events.push("access");
    return input.effectiveAccess?.(member) ?? access();
  });
  const clock = vi.fn(() => {
    events.push("clock");
    return input.clock?.() ?? now;
  });
  const member = {
    webOrigin: "https://app.syntholo.test",
    audience: "syntholo-member-api",
    authorizedParties: ["https://app.syntholo.test"],
    clerk: { authenticateRequest },
    identities: { findMemberActorByClerkUserId: vi.fn(async () => actor) },
    access: { getEffectiveAccess },
    dashboard: { accounts: { getById }, clock: { now: clock } },
  } as AuthRouteDependencies["member"];
  const result: ApiDependencies = {
    releaseSha: "1111111111111111111111111111111111111111",
    health: { dependencies: [] },
    auth: {
      kind: "enabled",
      dependencies: {
        member,
        staff: {
          config: {
            environment: "test", webOrigin: "https://app.syntholo.test",
            clientId: "client", organizationId: "org",
            callbackUrl: "https://app.syntholo.test/v1/staff/auth/callback",
            defaultReturnTo: "/admin", allowedReturnToPrefixes: ["/admin"],
            sessionHardTtlSeconds: 3600, loginAttemptTtlSeconds: 300,
            refreshLeaseSeconds: 5,
          },
          clock: { now: () => now },
          sessionCrypto: {} as AuthRouteDependencies["staff"]["sessionCrypto"],
          loginAttempts: {} as AuthRouteDependencies["staff"]["loginAttempts"],
          sessions: {} as AuthRouteDependencies["staff"]["sessions"],
          identities: {} as AuthRouteDependencies["staff"]["identities"],
          tokens: {} as AuthRouteDependencies["staff"]["tokens"],
          workos: {} as AuthRouteDependencies["staff"]["workos"],
          sleep: async () => undefined,
        },
      },
    },
  };
  return { result, events, authenticateRequest, getById, getEffectiveAccess, clock };
}

describe("GET /v1/member/dashboard", () => {
  it("returns the strict foundation projection after account then final access revalidation", async () => {
    const fixture = dependencies();
    const app = await buildApp(fixture.result);
    const response = await app.inject({
      method: "GET",
      url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(MemberDashboardResponseSchema.parse(response.json())).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-08-14T16:00:00.123Z",
      account: { id: actor.accountId, name: "Acme Advisory" },
      experience: { state: "partial" },
      nextBestStep: { kind: "unavailable", blockedBy: "support" },
    });
    expect(fixture.events).toEqual(["authenticate", "account", "access", "clock"]);
    expect(fixture.getById.mock.calls[0]?.slice(0, 2)).toEqual([
      { accountId: actor.accountId }, actor.accountId,
    ]);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toBe("Authorization, Syntholo-Dashboard-Version");
    expect(response.headers["syntholo-dashboard-version"]).toBe("1");
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/u);
    await app.close();
  });

  it("returns access-required as a valid 200 without demo or role fields", async () => {
    const fixture = dependencies({ effectiveAccess: async () => access(false) });
    const app = await buildApp(fixture.result);
    const response = await app.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      experience: { state: "access_required" },
      nextBestStep: { kind: "access_blocker" },
    });
    expect(response.payload).not.toMatch(/owner|Maria|Northstar|lesson|coach/iu);
    await app.close();
  });

  it.each([
    ["/v1/member/dashboard?accountId=10000000-0000-4000-8000-000000000002", {}, 400],
    ["/v1/member/dashboard?unknown=1", {}, 400],
    ["/v1/member/dashboard", { "syntholo-dashboard-version": "3" }, 400],
    ["/v1/member/dashboard", { "syntholo-dashboard-version": "1, 2" }, 400],
    ["/v1/member/dashboard", { "syntholo-dashboard-version": "2" }, 406],
  ])("validates request/version before authentication: %s %#", async (url, headers, status) => {
    const fixture = dependencies();
    const app = await buildApp(fixture.result);
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode).toBe(status);
    expect(fixture.authenticateRequest).not.toHaveBeenCalled();
    expect(fixture.getById).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toBe("Authorization, Syntholo-Dashboard-Version");
    await app.close();
  });

  it("rejects a GET body before authentication", async () => {
    const fixture = dependencies();
    const app = await buildApp(fixture.result);
    const response = await app.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { "content-type": "application/json" },
      payload: { accountId: actor.accountId },
    });
    expect(response.statusCode).toBe(400);
    expect(fixture.authenticateRequest).not.toHaveBeenCalled();
    expect(fixture.getById).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts explicit v1 and rejects repeated v1", async () => {
    const first = dependencies();
    const app = await buildApp(first.result);
    const accepted = await app.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token", "syntholo-dashboard-version": "1" },
    });
    expect(accepted.statusCode).toBe(200);
    const repeated = await app.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { "syntholo-dashboard-version": ["1", "1"] },
    });
    expect(repeated.statusCode).toBe(400);
    await app.close();
  });

  it.each([
    [new MemberAccessUnavailableError(), 401, "UNAUTHENTICATED"],
    [new DatabaseDependencyUnavailableError("query_timeout"), 503, "DEPENDENCY_UNAVAILABLE"],
    [Object.assign(new Error("secret db endpoint password"), { code: "57014" }), 500, "INTERNAL_ERROR"],
  ])("translates only allowlisted repository outcomes", async (error, status, code) => {
    const fixture = dependencies({ effectiveAccess: async () => { throw error; } });
    const app = await buildApp(fixture.result);
    const correlationId = "40000000-0000-4000-8000-000000000001";
    const response = await app.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token", "x-correlation-id": correlationId },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code, correlationId } });
    expect(response.headers["x-correlation-id"]).toBe(correlationId);
    expect(response.payload).not.toContain("secret db endpoint password");
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("returns collapsed 401 when the scoped account disappears and does not revalidate access", async () => {
    const fixture = dependencies({ account: async () => null });
    const app = await buildApp(fixture.result);
    const response = await app.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token" },
    });
    expect(response.statusCode).toBe(401);
    expect(fixture.getEffectiveAccess).not.toHaveBeenCalled();
    expect(response.payload).not.toContain("Acme");
    await app.close();
  });

  it("fails closed when account/access output or the post-access clock is malformed", async () => {
    const malformed = dependencies({ account: async () => ({ id: actor.accountId, name: " Bad " }) });
    const malformedApp = await buildApp(malformed.result);
    const malformedResponse = await malformedApp.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token" },
    });
    expect(malformedResponse.statusCode).toBe(500);
    expect(malformedResponse.payload).not.toContain(" Bad ");
    await malformedApp.close();

    const invalidClock = dependencies({ clock: () => new Date(Number.NaN) });
    const clockApp = await buildApp(invalidClock.result);
    const clockResponse = await clockApp.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token" },
    });
    expect(clockResponse.statusCode).toBe(500);
    expect(invalidClock.events).toEqual(["authenticate", "account", "access", "clock"]);
    await clockApp.close();
  });
});
