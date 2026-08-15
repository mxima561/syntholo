import type { EffectiveAccess } from "@syntholo/domain";
import { LearningRepositoryError } from "@syntholo/database";
import { MuxPlaybackDependencyUnavailableError } from "@syntholo/integrations";
import { memberActor } from "@syntholo/testing";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type ApiDependencies } from "../../app.js";
import type { AuthRouteDependencies } from "../../auth/types.js";

const actor = memberActor({
  actorId: "10000000-0000-4000-8000-000000000001", accountId: "10000000-0000-4000-8000-000000000002",
  membershipId: "10000000-0000-4000-8000-000000000003", clerkUserId: "clerk_learning",
  authenticatedAt: new Date("2026-08-15T12:00:00.000Z"),
});
const courseId = "10000000-0000-4000-8000-000000000004";
const lessonId = "10000000-0000-4000-8000-000000000005";
const course = { schemaVersion: 1, enrollmentId: "10000000-0000-4000-8000-000000000006", course: { id: courseId, versionId: "10000000-0000-4000-8000-000000000007", title: "Academy", description: "Course" }, stages: [], progress: { completedRequired: 0, requiredTotal: 18, percent: 0 } };
const lesson = {
  schemaVersion: 1, enrollmentId: "10000000-0000-4000-8000-000000000006",
  courseVersionId: "10000000-0000-4000-8000-000000000007", lessonId,
  lessonVersionId: "10000000-0000-4000-8000-000000000009", title: "Diagnose the gap",
  summary: "A complete lesson.", durationSeconds: 600,
  blocks: [{ type: "action", blockId: "action-1", title: "Apply", instructions: "Complete the exercise." }],
  transcript: { schemaVersion: 1, blocks: [{ blockId: "transcript-1", text: "Complete transcript text." }] },
  resources: [], progress: { revision: null, state: "not_started", lastPath: null, position: null },
  previousRequiredLessonId: null, nextRequiredLessonId: null,
};

function effectiveAccess(academyCourse = true): EffectiveAccess {
  return { accountId: actor.accountId, capabilities: { academy_course: academyCourse, support: false, circle_write: false, operator_club: false, business_os: false }, holds: [], seatLimit: 3, reservedSeats: 1, explanations: [
    { capability: "academy_course", sourceGrantIds: academyCourse ? ["10000000-0000-4000-8000-000000000099"] : [] },
    { capability: "support", sourceGrantIds: [] }, { capability: "circle_write", sourceGrantIds: [] },
    { capability: "operator_club", sourceGrantIds: [] }, { capability: "business_os", sourceGrantIds: [] },
  ] };
}

function dependencies(academyCourse = true) {
  const learning = { getCourse: vi.fn(async () => course), getLesson: vi.fn(async () => lesson), resumeLesson: vi.fn(async () => ({ revision: 1, state: "in_progress", lastPath: "transcript", position: { blockId: "transcript-1" } })), completeLesson: vi.fn(async () => ({ schemaVersion: 1, lessonCompletion: { id: "10000000-0000-4000-8000-000000000008", lessonVersionId: "10000000-0000-4000-8000-000000000009", method: "transcript", completedAt: "2026-08-15T12:00:00.000Z" }, courseCompletion: null, nextRequiredLessonId: null })), getPlaybackTarget: vi.fn(async () => ({ lessonVersionId: lesson.lessonVersionId, durationSeconds: 600, mediaState: "ready", signedPlaybackId: "signed_playback_1" })) };
  const member = { webOrigin: "https://app.syntholo.test", audience: "member", authorizedParties: ["https://app.syntholo.test"], clerk: { authenticateRequest: vi.fn(async () => ({ userId: actor.clerkUserId, firstFactorVerifiedAt: actor.authenticatedAt, authorizedParty: "https://app.syntholo.test" })) }, identities: { findMemberActorByClerkUserId: vi.fn(async () => actor) }, access: { getEffectiveAccess: vi.fn(async () => effectiveAccess(academyCourse)) }, learning } as unknown as AuthRouteDependencies["member"];
  const result: ApiDependencies = { releaseSha: "1".repeat(40), health: { dependencies: [] }, auth: { kind: "enabled", dependencies: { member, staff: { config: { environment: "test", webOrigin: "https://app.syntholo.test", clientId: "client", organizationId: "org", callbackUrl: "https://app.syntholo.test/v1/staff/auth/callback", defaultReturnTo: "/admin", allowedReturnToPrefixes: ["/admin"], sessionHardTtlSeconds: 3600, loginAttemptTtlSeconds: 300, refreshLeaseSeconds: 5 }, clock: { now: () => new Date() }, sessionCrypto: {} as never, loginAttempts: {} as never, sessions: {} as never, identities: {} as never, tokens: {} as never, workos: {} as never, sleep: async () => undefined } } } };
  return { result, learning };
}

describe("member learning routes", () => {
  it("loads the actor-pinned course only after academy entitlement", async () => {
    const { result, learning } = dependencies(); const app = await buildApp(result);
    const correlationId = "40000000-0000-4000-8000-000000000001";
    const response = await app.inject({ method: "GET", url: `/v1/member/courses/${courseId}`, headers: { authorization: "Bearer member-token", "x-correlation-id": correlationId } });
    expect(response.statusCode, response.payload).toBe(200); expect(response.json()).toEqual(course);
    expect(learning.getCourse).toHaveBeenCalledWith(actor, correlationId, courseId); expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("denies learning before calling storage when academy access is absent", async () => {
    const { result, learning } = dependencies(false); const app = await buildApp(result);
    const response = await app.inject({ method: "GET", url: `/v1/member/courses/${courseId}`, headers: { authorization: "Bearer member-token" } });
    expect(response.statusCode).toBe(403); expect(learning.getCourse).not.toHaveBeenCalled(); await app.close();
  });

  it("fails closed on an access projection for another account before storage", async () => {
    const { result, learning } = dependencies();
    const member = (result.auth.kind === "enabled" ? result.auth.dependencies.member : undefined)!;
    member.access.getEffectiveAccess = vi.fn(async () => ({
      ...effectiveAccess(true), accountId: "10000000-0000-4000-8000-000000000099",
    }));
    const app = await buildApp(result);
    const response = await app.inject({ method: "GET", url: `/v1/member/courses/${courseId}`, headers: { authorization: "Bearer member-token" } });
    expect(response.statusCode).toBe(500);
    expect(learning.getCourse).not.toHaveBeenCalled();
    await app.close();
  });

  it("validates transcript resume and forwards completion idempotency", async () => {
    const { result, learning } = dependencies(); const app = await buildApp(result);
    const correlationId = "40000000-0000-4000-8000-000000000002";
    const resume = await app.inject({ method: "PUT", url: `/v1/member/lessons/${lessonId}/resume`, headers: { authorization: "Bearer member-token", "content-type": "application/json", "x-correlation-id": correlationId }, payload: { expectedVersion: 0, path: "transcript", position: { blockId: "transcript-1" } } });
    expect(resume.statusCode, resume.payload).toBe(200);
    const complete = await app.inject({ method: "POST", url: `/v1/member/lessons/${lessonId}/complete`, headers: { authorization: "Bearer member-token", "content-type": "application/json", "idempotency-key": "complete-intent-0001", "x-correlation-id": correlationId }, payload: { method: "transcript" } });
    expect(complete.statusCode, complete.payload).toBe(200);
    expect(learning.completeLesson).toHaveBeenCalledWith(actor, correlationId, lessonId, { method: "transcript" }, "complete-intent-0001");
    await app.close();
  });

  it("returns a truthful transcript fallback without any token when Mux signing is unavailable", async () => {
    const { result } = dependencies(); const app = await buildApp(result);
    const response = await app.inject({ method: "GET", url: `/v1/member/lessons/${lessonId}/playback`, headers: { authorization: "Bearer member-token" } });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.json()).toMatchObject({
      playbackStatus: "degraded", reason: "MUX_UNAVAILABLE",
      fallback: { title: lesson.title, transcript: lesson.transcript, blocks: lesson.blocks },
    });
    expect(response.payload).not.toMatch(/playbackToken|signed_playback_1/u);
    await app.close();
  });

  it("degrades only a typed playback dependency failure and leaves unknown signer faults visible", async () => {
    const typed = dependencies();
    if (typed.result.auth.kind !== "enabled") throw new Error("TEST_AUTH_INVALID");
    typed.result.auth.dependencies.member.playback = {
      clock: { now: () => new Date("2026-08-15T12:00:00.000Z") },
      sign: vi.fn(async () => { throw new MuxPlaybackDependencyUnavailableError(); }),
    };
    const typedApp = await buildApp(typed.result);
    const degraded = await typedApp.inject({ method: "GET", url: `/v1/member/lessons/${lessonId}/playback`, headers: { authorization: "Bearer member-token" } });
    expect(degraded.statusCode).toBe(200); expect(degraded.json()).toMatchObject({ playbackStatus: "degraded", reason: "MUX_UNAVAILABLE" });
    await typedApp.close();

    const unknown = dependencies();
    if (unknown.result.auth.kind !== "enabled") throw new Error("TEST_AUTH_INVALID");
    unknown.result.auth.dependencies.member.playback = {
      clock: { now: () => new Date("2026-08-15T12:00:00.000Z") },
      sign: vi.fn(async () => { throw new Error("bad signing key"); }),
    };
    const unknownApp = await buildApp(unknown.result);
    const failed = await unknownApp.inject({ method: "GET", url: `/v1/member/lessons/${lessonId}/playback`, headers: { authorization: "Bearer member-token" } });
    expect(failed.statusCode).toBe(500); expect(failed.payload).not.toContain("bad signing key");
    await unknownApp.close();
  });

  it("fails closed when fallback and playback target versions diverge", async () => {
    const { result, learning } = dependencies();
    learning.getPlaybackTarget.mockResolvedValueOnce({ lessonVersionId: "10000000-0000-4000-8000-000000000099", durationSeconds: 600, mediaState: "ready", signedPlaybackId: "signed_playback_1" });
    const app = await buildApp(result);
    const response = await app.inject({ method: "GET", url: `/v1/member/lessons/${lessonId}/playback`, headers: { authorization: "Bearer member-token" } });
    expect(response.statusCode).toBe(500); expect(response.payload).not.toContain("signed_playback_1"); await app.close();
  });

  it("maps invalid resume position to a deterministic client error", async () => {
    const { result, learning } = dependencies();
    learning.resumeLesson.mockRejectedValueOnce(new LearningRepositoryError("LEARNING_RESUME_INVALID"));
    const app = await buildApp(result);
    const response = await app.inject({ method: "PUT", url: `/v1/member/lessons/${lessonId}/resume`, headers: { authorization: "Bearer member-token", "content-type": "application/json" }, payload: { expectedVersion: 0, path: "video", position: { seconds: 700 } } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "LEARNING_RESUME_INVALID" } });
    await app.close();
  });

  it.each([
    [`/v1/member/courses/${courseId}?extra=1`, undefined, 400],
    [`/v1/member/lessons/${lessonId}?extra=1`, undefined, 400],
    [`/v1/member/lessons/${lessonId}/resume?extra=1`, { expectedVersion: 0, path: "transcript", position: { blockId: "transcript-1" } }, 400],
  ])("rejects non-canonical request shapes before storage: %s", async (url, payload, expected) => {
    const { result, learning } = dependencies(); const app = await buildApp(result);
    const response = await app.inject({ method: payload === undefined ? "GET" : "PUT", url, headers: { authorization: "Bearer member-token", ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode).toBe(expected);
    expect(learning.getCourse).not.toHaveBeenCalled(); expect(learning.getLesson).not.toHaveBeenCalled(); expect(learning.resumeLesson).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["short", "é".repeat(16), "x".repeat(129), "key,another-key"])("rejects an invalid completion idempotency key: %s", async (key) => {
    const { result, learning } = dependencies(); const app = await buildApp(result);
    const response = await app.inject({ method: "POST", url: `/v1/member/lessons/${lessonId}/complete`, headers: { authorization: "Bearer member-token", "content-type": "application/json", "idempotency-key": key }, payload: { method: "transcript" } });
    expect(response.statusCode).toBe(400); expect(learning.completeLesson).not.toHaveBeenCalled(); await app.close();
  });
});
