import type { EffectiveAccess, MemberActor } from "@syntholo/domain";
import {
  DatabaseDependencyUnavailableError,
  ImplementationRepositoryError,
  MemberAccessUnavailableError,
} from "@syntholo/database";
import {
  MemberDashboardResponseSchema,
  MemberDashboardV2ResponseSchema,
  MemberDashboardV3ResponseSchema,
} from "@syntholo/contracts/member-dashboard";
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
const dashboardCourse = {
  schemaVersion: 1 as const,
  enrollmentId: "10000000-0000-4000-8000-000000000041",
  course: {
    id: "10000000-0000-4000-8000-000000000042",
    versionId: "10000000-0000-4000-8000-000000000043",
    title: "Syntholo Academy",
    description: "The implementation course.",
  },
  stages: [],
  progress: { completedRequired: 0, requiredTotal: 18 as const, percent: 0 },
};

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
  dashboardCourse?: () => Promise<unknown>;
  artifacts?: () => Promise<unknown>;
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
  const getById = vi.fn(async (
    scope: Readonly<{ accountId: string }>,
    id: string,
    parentDeadline?: number,
  ) => {
    void scope;
    void id;
    void parentDeadline;
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
  const getEffectiveAccess = vi.fn(async (member: MemberActor, parentDeadline?: number) => {
    void parentDeadline;
    events.push("access");
    return input.effectiveAccess?.(member) ?? access();
  });
  const clock = vi.fn(() => {
    events.push("clock");
    return input.clock?.() ?? now;
  });
  const getDashboardCourse = vi.fn(async (
    member: MemberActor,
    correlationId: string,
    parentDeadline?: number,
  ) => {
    void member;
    void correlationId;
    void parentDeadline;
    events.push("learning");
    return input.dashboardCourse?.() ?? dashboardCourse;
  });
  const listArtifacts = vi.fn(async (
    member: MemberActor,
    correlationId: string,
    parentDeadline?: number,
  ) => {
    void member;
    void correlationId;
    void parentDeadline;
    events.push("implementation");
    return input.artifacts?.() ?? {
      schemaVersion: 1,
      items: ["readiness_map", "ai_policy", "workflow_portfolio", "enablement_checklist", "roadmap"]
        .map((kind, index) => ({ id: `30000000-0000-4000-8000-00000000000${index + 1}`, kind, title: `Artifact ${index + 1}`, currentVersion: 0, currentState: null, currentVersionId: null, updatedAt: null, authorLabel: null })),
      nextCursor: null,
      implementationCompletion: { completed: false, completedAt: null },
    };
  });
  const member = {
    webOrigin: "https://app.syntholo.test",
    audience: "syntholo-member-api",
    authorizedParties: ["https://app.syntholo.test"],
    clerk: { authenticateRequest },
    identities: { findMemberActorByClerkUserId: vi.fn(async () => actor) },
    access: { getEffectiveAccess },
    dashboard: { accounts: { getById }, clock: { now: clock } },
    learning: {
      getDashboardCourse,
    },
    implementation: { list: listArtifacts },
  } as unknown as AuthRouteDependencies["member"];
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
          access: {} as AuthRouteDependencies["staff"]["access"],
          sleep: async () => undefined,
        },
      },
    },
  };
  return {
    result, events, authenticateRequest, getById, getEffectiveAccess,
    getDashboardCourse, listArtifacts, clock,
  };
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

  it("returns strict v2 learning from the exact active enrollment without changing default v1", async () => {
    const fixture = dependencies();
    const app = await buildApp(fixture.result);
    const response = await app.inject({
      method: "GET",
      url: "/v1/member/dashboard",
      headers: {
        authorization: "Bearer member-token",
        "syntholo-dashboard-version": "2",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(MemberDashboardV2ResponseSchema.parse(response.json())).toMatchObject({
      schemaVersion: 2,
      learning: { state: "available", course: dashboardCourse },
      nextBestStep: {
        kind: "course",
        reason: "required_lesson_locked",
        target: { courseId: dashboardCourse.course.id },
      },
    });
    expect(response.headers["syntholo-dashboard-version"]).toBe("2");
    expect(fixture.events).toEqual([
      "authenticate", "account", "access", "learning", "access", "clock",
    ]);

    const v1 = await app.inject({
      method: "GET",
      url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token" },
    });
    expect(v1.statusCode).toBe(200);
    expect(v1.json()).toMatchObject({ schemaVersion: 1 });
    expect(fixture.getDashboardCourse).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns additive v3 implementation roots while preserving the v2 learning next step", async () => {
    const fixture = dependencies();
    const app = await buildApp(fixture.result);
    const response = await app.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token", "syntholo-dashboard-version": "3" },
    });
    expect(response.statusCode).toBe(200);
    expect(MemberDashboardV3ResponseSchema.parse(response.json())).toMatchObject({
      schemaVersion: 3,
      learning: { state: "available", course: dashboardCourse },
      implementation: { state: "available", artifacts: { items: expect.any(Array) } },
      nextBestStep: { kind: "course", reason: "required_lesson_locked" },
    });
    expect(response.headers["syntholo-dashboard-version"]).toBe("3");
    expect(fixture.events).toEqual([
      "authenticate", "account", "access", "learning", "access", "implementation", "access", "clock",
    ]);
    const deadline = fixture.getById.mock.calls[0]?.[2];
    expect(deadline).toEqual(expect.any(Number));
    expect(fixture.getEffectiveAccess.mock.calls.every((call) => call[1] === deadline)).toBe(true);
    expect(fixture.getDashboardCourse.mock.calls[0]?.[2]).toBe(deadline);
    expect(fixture.listArtifacts.mock.calls[0]?.[2]).toBe(deadline);
    await app.close();
  });

  it("suppresses implementation content when Academy access is revoked after its read", async () => {
    const effectiveAccess = vi.fn()
      .mockResolvedValueOnce(access(true))
      .mockResolvedValueOnce(access(true))
      .mockResolvedValueOnce(access(false));
    const fixture = dependencies({ effectiveAccess });
    const app = await buildApp(fixture.result);
    const response = await app.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token", "syntholo-dashboard-version": "3" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 3,
      experience: { state: "access_required" },
      learning: { state: "blocked", reason: "course_access_required" },
      implementation: { state: "blocked", reason: "course_access_required" },
    });
    expect(response.payload).not.toContain("Artifact 1");
    expect(fixture.listArtifacts).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("distinguishes a revoked implementation NOT_FOUND from an active workspace invariant failure", async () => {
    const notFound = async () => { throw new ImplementationRepositoryError("IMPLEMENTATION_NOT_FOUND"); };
    const revokedAccess = vi.fn()
      .mockResolvedValueOnce(access(true))
      .mockResolvedValueOnce(access(true))
      .mockResolvedValueOnce(access(false));
    const revoked = dependencies({ effectiveAccess: revokedAccess, artifacts: notFound });
    const revokedApp = await buildApp(revoked.result);
    const revokedResponse = await revokedApp.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token", "syntholo-dashboard-version": "3" },
    });
    expect(revokedResponse.statusCode).toBe(200);
    expect(revokedResponse.json()).toMatchObject({
      experience: { state: "access_required" },
      implementation: { state: "blocked" },
    });
    await revokedApp.close();

    const active = dependencies({ artifacts: notFound });
    const activeApp = await buildApp(active.result);
    const activeResponse = await activeApp.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token", "syntholo-dashboard-version": "3" },
    });
    expect(activeResponse.statusCode).toBe(500);
    expect(activeResponse.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(activeResponse.payload).not.toContain("IMPLEMENTATION_NOT_FOUND");
    await activeApp.close();
  });

  it("maps a typed v3 implementation dependency failure to the canonical safe 503", async () => {
    const fixture = dependencies({
      artifacts: async () => { throw new ImplementationRepositoryError("IMPLEMENTATION_DEPENDENCY_FAILED"); },
    });
    const app = await buildApp(fixture.result);
    const response = await app.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token", "syntholo-dashboard-version": "3" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "DEPENDENCY_UNAVAILABLE" } });
    expect(response.payload).not.toContain("IMPLEMENTATION_DEPENDENCY_FAILED");
    await app.close();
  });

  it("revalidates effective access after learning and suppresses a course revoked during the read", async () => {
    const effectiveAccess = vi.fn()
      .mockResolvedValueOnce(access(true))
      .mockResolvedValueOnce(access(false));
    const fixture = dependencies({ effectiveAccess });
    const app = await buildApp(fixture.result);
    const response = await app.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token", "syntholo-dashboard-version": "2" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      experience: { state: "access_required" },
      learning: { state: "blocked", reason: "course_access_required" },
    });
    expect(response.payload).not.toContain(dashboardCourse.course.title);
    expect(fixture.events).toEqual([
      "authenticate", "account", "access", "learning", "access", "clock",
    ]);
    await app.close();
  });

  it("returns honest v2 access and enrollment blockers without inventing a course", async () => {
    const accessFixture = dependencies({ effectiveAccess: async () => access(false) });
    const accessApp = await buildApp(accessFixture.result);
    const accessResponse = await accessApp.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token", "syntholo-dashboard-version": "2" },
    });
    expect(accessResponse.statusCode).toBe(200);
    expect(accessResponse.json()).toMatchObject({
      experience: { state: "access_required" },
      learning: { state: "blocked", reason: "course_access_required" },
    });
    expect(accessFixture.getDashboardCourse).not.toHaveBeenCalled();
    await accessApp.close();

    const enrollmentFixture = dependencies({ dashboardCourse: async () => null });
    const enrollmentApp = await buildApp(enrollmentFixture.result);
    const enrollmentResponse = await enrollmentApp.inject({
      method: "GET", url: "/v1/member/dashboard",
      headers: { authorization: "Bearer member-token", "syntholo-dashboard-version": "2" },
    });
    expect(enrollmentResponse.statusCode).toBe(200);
    expect(enrollmentResponse.json()).toMatchObject({
      experience: { state: "no_enrollment" },
      learning: { state: "empty", reason: "no_enrollment" },
    });
    await enrollmentApp.close();
  });

  it.each([
    ["/v1/member/dashboard?accountId=10000000-0000-4000-8000-000000000002", {}, 400],
    ["/v1/member/dashboard?unknown=1", {}, 400],
    ["/v1/member/dashboard", { "syntholo-dashboard-version": "4" }, 400],
    ["/v1/member/dashboard", { "syntholo-dashboard-version": "1, 2" }, 400],
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
