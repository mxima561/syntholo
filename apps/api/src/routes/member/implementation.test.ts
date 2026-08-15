import { canonicalizeArtifactContent } from "@syntholo/domain/implementation";
import { DatabaseDependencyUnavailableError, ImplementationRepositoryError } from "@syntholo/database";
import type { EffectiveAccess } from "@syntholo/domain";
import { memberActor } from "@syntholo/testing";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type ApiDependencies } from "../../app.js";

const actor = memberActor({
  actorId: "10000000-0000-4000-8000-000000000001",
  accountId: "10000000-0000-4000-8000-000000000002",
  membershipId: "10000000-0000-4000-8000-000000000003",
  clerkUserId: "clerk_implementation",
  authenticatedAt: new Date("2026-08-15T12:00:00.000Z"),
});
const artifactId = "10000000-0000-4000-8000-000000000010";
const versionId = "10000000-0000-4000-8000-000000000011";
const correlationId = "10000000-0000-4000-8000-000000000012";
const content = {
  kind: "ai_policy",
  purpose: "Set safe team boundaries.",
  approvedUses: ["Draft internal summaries"],
  prohibitedUses: ["Make final hiring decisions"],
  humanReviewRules: ["A person approves external claims"],
} as const;
const emptyRoots = [
  [artifactId, "ai_policy", "AI policy"],
  ["10000000-0000-4000-8000-000000000020", "readiness_map", "Readiness map"],
  ["10000000-0000-4000-8000-000000000030", "workflow_portfolio", "Workflow portfolio"],
  ["10000000-0000-4000-8000-000000000040", "enablement_checklist", "Enablement checklist"],
  ["10000000-0000-4000-8000-000000000050", "roadmap", "Roadmap"],
].map(([id, kind, title]) => ({
  id, kind, title, currentVersion: 0, currentState: null, currentVersionId: null,
  updatedAt: null, authorLabel: null,
}));
const detail = {
  schemaVersion: 1,
  artifact: {
    id: artifactId, kind: "ai_policy", title: "AI policy", currentVersion: 1,
    currentState: "draft", currentVersionId: versionId,
    updatedAt: "2026-08-15T12:00:00.000Z", authorLabel: "You",
  },
  content,
} as const;
const saved = {
  schemaVersion: 1,
  artifact: detail.artifact,
  version: {
    id: versionId, version: 1, state: "draft",
    contentHash: canonicalizeArtifactContent(content).hash,
    createdAt: "2026-08-15T12:00:00.000Z", authorLabel: "You",
  },
  content,
  implementationCompletion: { completed: false, completedAt: null },
} as const;

function effectiveAccess(enabled = true): EffectiveAccess {
  return {
    accountId: actor.accountId,
    capabilities: {
      academy_course: enabled, support: false, circle_write: false,
      operator_club: false, business_os: false,
    },
    holds: [], seatLimit: 3, reservedSeats: 1,
    explanations: [
      { capability: "academy_course", sourceGrantIds: enabled ? ["10000000-0000-4000-8000-000000000099"] : [] },
      { capability: "support", sourceGrantIds: [] },
      { capability: "circle_write", sourceGrantIds: [] },
      { capability: "operator_club", sourceGrantIds: [] },
      { capability: "business_os", sourceGrantIds: [] },
    ],
  };
}

function dependencies(enabled = true) {
  const implementation = {
    list: vi.fn(async () => ({
      schemaVersion: 1, items: emptyRoots, nextCursor: null,
      implementationCompletion: { completed: false, completedAt: null },
    })),
    get: vi.fn(async () => detail),
    versions: vi.fn(async () => ({ schemaVersion: 1, items: [saved.version], nextCursor: null })),
    saveVersion: vi.fn(async () => saved),
  };
  const member = {
    webOrigin: "https://app.syntholo.test", audience: "member",
    authorizedParties: ["https://app.syntholo.test"],
    clerk: { authenticateRequest: vi.fn(async () => ({
      userId: actor.clerkUserId, firstFactorVerifiedAt: actor.authenticatedAt,
      authorizedParty: "https://app.syntholo.test",
    })) },
    identities: { findMemberActorByClerkUserId: vi.fn(async () => actor) },
    access: { getEffectiveAccess: vi.fn(async () => effectiveAccess(enabled)) },
    implementation,
  };
  const result = {
    releaseSha: "1".repeat(40), health: { dependencies: [] },
    auth: { kind: "enabled", dependencies: {
      member,
      staff: {
        config: { environment: "test", webOrigin: "https://app.syntholo.test", clientId: "client", organizationId: "org", callbackUrl: "https://app.syntholo.test/v1/staff/auth/callback", defaultReturnTo: "/admin", allowedReturnToPrefixes: ["/admin"], sessionHardTtlSeconds: 3600, loginAttemptTtlSeconds: 300, refreshLeaseSeconds: 5 },
        clock: { now: () => new Date() }, sessionCrypto: {}, loginAttempts: {}, sessions: {}, identities: {}, tokens: {}, workos: {}, sleep: async () => undefined,
      },
    } },
  } as unknown as ApiDependencies;
  return { implementation, result };
}

describe("member implementation artifact routes", () => {
  it("registers exactly the list, detail, history, and receipt-backed save flows", async () => {
    const { implementation, result } = dependencies();
    const app = await buildApp(result);
    const headers = { authorization: "Bearer member-token", "x-correlation-id": correlationId };
    const list = await app.inject({ method: "GET", url: "/v1/member/artifacts", headers });
    expect(list.statusCode, list.payload).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.headers.vary).toBe("Authorization");
    const get = await app.inject({ method: "GET", url: `/v1/member/artifacts/${artifactId}`, headers });
    expect(get.statusCode, get.payload).toBe(200);
    const versions = await app.inject({ method: "GET", url: `/v1/member/artifacts/${artifactId}/versions?limit=25`, headers });
    expect(versions.statusCode, versions.payload).toBe(200);
    const post = await app.inject({
      method: "POST", url: `/v1/member/artifacts/${artifactId}/versions`,
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "artifact-intent-0001" },
      payload: { expectedVersion: 0, state: "draft", content },
    });
    expect(post.statusCode, post.payload).toBe(201);
    expect(implementation.list).toHaveBeenCalledWith(actor, correlationId);
    expect(implementation.get).toHaveBeenCalledWith(actor, correlationId, artifactId);
    expect(implementation.versions).toHaveBeenCalledWith(actor, correlationId, artifactId, { limit: 25 });
    expect(implementation.saveVersion).toHaveBeenCalledWith(
      actor, correlationId, artifactId,
      { expectedVersion: 0, state: "draft", content }, "artifact-intent-0001",
    );
    await app.close();
  });

  it("rejects bodies, unknown queries, malformed pagination, unsafe keys, and implicit HEAD before storage", async () => {
    const { implementation, result } = dependencies();
    const app = await buildApp(result);
    const base = `/v1/member/artifacts/${artifactId}`;
    for (const request of [
      { method: "GET", url: "/v1/member/artifacts?extra=1" },
      { method: "GET", url: base, payload: {} },
      { method: "GET", url: `${base}/versions?limit=1e1` },
      { method: "GET", url: `${base}/versions?cursor=forged` },
      { method: "POST", url: `${base}/versions`, headers: { "content-type": "application/json", "idempotency-key": "contains/slash-key" }, payload: { expectedVersion: 0, state: "draft", content } },
      { method: "POST", url: `${base}/versions?extra=1`, headers: { "content-type": "application/json", "idempotency-key": "artifact-intent-0001" }, payload: { expectedVersion: 0, state: "draft", content } },
      { method: "POST", url: `${base}/versions`, headers: { "content-type": "application/json", "idempotency-key": "artifact-intent-0001" }, payload: { expectedVersion: 0, state: "draft", content, extra: true } },
    ] as const) {
      const response = await app.inject({ ...request, headers: { authorization: "Bearer member-token", ...request.headers } });
      expect(response.statusCode, response.payload).toBe(400);
    }
    expect((await app.inject({ method: "HEAD", url: base, headers: { authorization: "Bearer member-token" } })).statusCode).toBe(404);
    expect(implementation.list).not.toHaveBeenCalled();
    expect(implementation.get).not.toHaveBeenCalled();
    expect(implementation.versions).not.toHaveBeenCalled();
    expect(implementation.saveVersion).not.toHaveBeenCalled();
    await app.close();
  });

  it("authorizes the resolved member before any artifact storage call", async () => {
    const { implementation, result } = dependencies(false);
    const app = await buildApp(result);
    const response = await app.inject({ method: "GET", url: "/v1/member/artifacts", headers: { authorization: "Bearer member-token" } });
    expect(response.statusCode).toBe(403);
    expect(implementation.list).not.toHaveBeenCalled();
    const post = await app.inject({
      method: "POST", url: `/v1/member/artifacts/${artifactId}/versions`,
      headers: { authorization: "Bearer member-token", "content-type": "application/json", "idempotency-key": "artifact-intent-0001" },
      payload: { expectedVersion: 0, state: "draft", content },
    });
    expect(post.statusCode).toBe(403);
    expect(implementation.saveVersion).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [new ImplementationRepositoryError("IMPLEMENTATION_NOT_FOUND"), 404, "NOT_FOUND"],
    [new ImplementationRepositoryError("VERSION_CONFLICT"), 409, "VERSION_CONFLICT"],
    [new ImplementationRepositoryError("IDEMPOTENCY_KEY_REUSED"), 409, "IDEMPOTENCY_KEY_REUSED"],
    [new ImplementationRepositoryError("IDEMPOTENCY_IN_PROGRESS"), 409, "IDEMPOTENCY_IN_PROGRESS"],
    [new ImplementationRepositoryError("INVALID_CURSOR"), 400, "INVALID_CURSOR"],
    [new ImplementationRepositoryError("IMPLEMENTATION_COMMAND_INVALID"), 400, "IMPLEMENTATION_COMMAND_INVALID"],
    [new ImplementationRepositoryError("IMPLEMENTATION_DEPENDENCY_FAILED"), 503, "DEPENDENCY_UNAVAILABLE"],
    [new DatabaseDependencyUnavailableError("query_timeout"), 503, "DEPENDENCY_UNAVAILABLE"],
  ] as const)("maps a safe repository failure without leaking content", async (failure, status, code) => {
    const { implementation, result } = dependencies();
    implementation.saveVersion.mockRejectedValueOnce(failure);
    const app = await buildApp(result);
    const response = await app.inject({
      method: "POST", url: `/v1/member/artifacts/${artifactId}/versions`,
      headers: { authorization: "Bearer member-token", "content-type": "application/json", "idempotency-key": "artifact-intent-0001" },
      payload: { expectedVersion: 0, state: "draft", content },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(response.payload).not.toContain(content.purpose);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toBe("Authorization");
    if (failure instanceof ImplementationRepositoryError && failure.code === "IDEMPOTENCY_IN_PROGRESS") {
      expect(response.headers["retry-after"]).toBe("1");
    }
    await app.close();
  });
});
