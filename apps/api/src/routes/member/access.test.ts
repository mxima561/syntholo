import type { EffectiveAccess, MemberActor } from "@syntholo/domain";
import { MemberAccessResponseSchema } from "@syntholo/contracts";
import { MemberAccessUnavailableError } from "@syntholo/database";
import { memberActor } from "@syntholo/testing";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type ApiDependencies } from "../../app.js";
import type { AuthRouteDependencies } from "../../auth/types.js";

const now = new Date("2026-08-13T12:00:00.123Z");
const actor = memberActor({
  actorId: "10000000-0000-4000-8000-000000000011",
  accountId: "10000000-0000-4000-8000-000000000001",
  membershipId: "10000000-0000-4000-8000-000000000021",
  clerkUserId: "clerk_member_access",
  authenticatedAt: now,
});

const access: EffectiveAccess = {
  accountId: actor.accountId,
  capabilities: {
    academy_course: true,
    support: false,
    circle_write: false,
    operator_club: false,
    business_os: false,
  },
  holds: [],
  seatLimit: 3,
  reservedSeats: 1,
  explanations: [
    { capability: "academy_course", sourceGrantIds: [
      "10000000-0000-4000-8000-000000000031",
    ] },
    { capability: "support", sourceGrantIds: [] },
    { capability: "circle_write", sourceGrantIds: [] },
    { capability: "operator_club", sourceGrantIds: [] },
    { capability: "business_os", sourceGrantIds: [] },
  ],
};

function dependencies(
  getEffectiveAccess: (actor: MemberActor) => Promise<unknown>,
): ApiDependencies {
  const member: AuthRouteDependencies["member"] = {
    webOrigin: "https://app.syntholo.test",
    audience: "syntholo-member-api",
    authorizedParties: ["https://app.syntholo.test"],
    clerk: {
      authenticateRequest: vi.fn(async () => ({
        userId: actor.clerkUserId,
        firstFactorVerifiedAt: actor.authenticatedAt,
        authorizedParty: "https://app.syntholo.test",
      })),
    },
    identities: { findMemberActorByClerkUserId: vi.fn(async () => actor) },
    access: { getEffectiveAccess },
  };
  return {
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
}

describe("GET /v1/member/access", () => {
  it("derives account from the authenticated actor and returns parsed access", async () => {
    const getEffectiveAccess = vi.fn(async () => access);
    const app = await buildApp(dependencies(getEffectiveAccess));
    const response = await app.inject({
      method: "GET",
      url: "/v1/member/access",
      headers: { authorization: "Bearer member-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(MemberAccessResponseSchema.parse(response.json())).toEqual(access);
    expect(getEffectiveAccess).toHaveBeenCalledWith(actor);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toContain("Authorization");
    await app.close();
  });

  it("returns evaluator-valid access explained by more than 64 additive sources", async () => {
    const sourceGrantIds = Array.from({ length: 65 }, (_value, index) =>
      `10000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`);
    const additive = {
      ...access,
      explanations: access.explanations.map((explanation, index) =>
        index === 0 ? { ...explanation, sourceGrantIds } : explanation),
    };
    const app = await buildApp(dependencies(async () => additive));
    const response = await app.inject({
      method: "GET", url: "/v1/member/access",
      headers: { authorization: "Bearer member-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(additive);
    await app.close();
  });

  it.each(["?accountId=10000000-0000-4000-8000-000000000002", "?unknown=1"])(
    "rejects nonempty query %s before loading access",
    async (query) => {
      const getEffectiveAccess = vi.fn(async () => access);
      const app = await buildApp(dependencies(getEffectiveAccess));
      const response = await app.inject({
        method: "GET", url: `/v1/member/access${query}`,
        headers: { authorization: "Bearer member-token" },
      });
      expect(response.statusCode).toBe(400);
      expect(getEffectiveAccess).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("rejects internal repository fields instead of serializing them", async () => {
    const app = await buildApp(dependencies(async () => ({
      ...access,
      internalSourceRegistryIds: ["do-not-leak"],
    })));
    const response = await app.inject({
      method: "GET", url: "/v1/member/access",
      headers: { authorization: "Bearer member-token" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.payload).not.toContain("do-not-leak");
    await app.close();
  });

  it("preserves authentication failures instead of returning all-false access", async () => {
    const getEffectiveAccess = vi.fn(async () => access);
    const deps = dependencies(getEffectiveAccess);
    if (deps.auth.kind !== "enabled") throw new Error("TEST_SETUP_INVALID");
    deps.auth.dependencies.member.identities.findMemberActorByClerkUserId =
      vi.fn(async () => null);
    const app = await buildApp(deps);
    const response = await app.inject({
      method: "GET", url: "/v1/member/access",
      headers: { authorization: "Bearer member-token" },
    });
    expect(response.statusCode).toBe(401);
    expect(getEffectiveAccess).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps a repository access-unavailable error to authentication failure", async () => {
    const app = await buildApp(dependencies(async () => {
      throw new MemberAccessUnavailableError();
    }));
    const response = await app.inject({
      method: "GET", url: "/v1/member/access",
      headers: { authorization: "Bearer member-token" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    });
    await app.close();
  });
});
