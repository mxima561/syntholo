import { staffActor } from "@syntholo/testing";
import { ContentCommandConflictError } from "@syntholo/database";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestContextPlugin } from "../../plugins/context.js";
import { safeErrorHandler } from "../../plugins/error-handler.js";
import { projectStaffActor } from "../../auth/authorize.js";

const actor = staffActor({
  actorId: "10000000-0000-4000-8000-000000000001",
  staffId: "10000000-0000-4000-8000-000000000001",
  role: "admin",
  permissions: ["content:read", "content:publish"],
  authenticatedAt: new Date("2026-08-14T16:00:00.000Z"),
});
const trustedActor = projectStaffActor(actor, new Date("2026-08-14T16:00:00.000Z"));

vi.mock("../../auth/staff.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../auth/staff.js")>();
  return { ...original, authenticateStaff: vi.fn(async () => trustedActor) };
});

describe("staff content publication routes", () => {
  const derivePreview = vi.fn();
  const materializePreview = vi.fn();
  const publishCourse = vi.fn();
  const publishLesson = vi.fn();

  beforeEach(() => {
    derivePreview.mockReset().mockResolvedValue({
      draftRevision: 2,
      candidateManifestHash: "a".repeat(64), manifest: { schemaVersion: 1, course: {}, stages: [] },
      publicationIssues: [],
    });
    materializePreview.mockReset().mockResolvedValue({
      previewId: "10000000-0000-4000-8000-000000000011",
      manifestHash: "a".repeat(64), manifest: { schemaVersion: 1, course: {}, stages: [] },
      publicationIssues: [], createdAt: "2026-08-14T16:00:00.000Z",
    });
    publishCourse.mockReset().mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000012",
      courseId: "10000000-0000-4000-8000-000000000010", version: 1,
      manifestHash: "a".repeat(64), headRevision: 1,
      publishedAt: "2026-08-14T16:00:00.000Z",
    });
    publishLesson.mockReset().mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000013", lessonId: "10000000-0000-4000-8000-000000000014",
      courseId: "10000000-0000-4000-8000-000000000010", version: 1, contentHash: "b".repeat(64),
      publishedAt: "2026-08-14T16:00:00.000Z",
    });
  });

  async function app() {
    const instance = Fastify({ logger: false, genReqId: () => "40000000-0000-4000-8000-000000000001" });
    await instance.register(requestContextPlugin);
    instance.setErrorHandler(safeErrorHandler);
    const { staffContentRoutes } = await import("./content.js");
    await instance.register(staffContentRoutes, {
      staff: {
        config: { environment: "test", webOrigin: "https://app.syntholo.test" },
        clock: { now: () => new Date("2026-08-14T16:02:00.000Z") },
      },
      content: { derivePreview, materializePreview, publishCourse, publishLesson },
    } as never);
    return instance;
  }

  it("derives an exact preview through the read permission without CSRF, idempotency, or writes", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "GET",
      url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/preview?draftRevision=2",
      headers: { cookie: "syntholo_local_staff_session=test" },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.json()).toEqual({
      draftRevision: 2, candidateManifestHash: "a".repeat(64),
      manifest: { schemaVersion: 1, course: {}, stages: [] }, publicationIssues: [],
    });
    expect(derivePreview).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, courseId: "10000000-0000-4000-8000-000000000010", draftRevision: 2,
    }));
    expect(materializePreview).not.toHaveBeenCalled();
    await instance.close();
  });

  it("materializes an exact preview only after staff permission, recent auth, and CSRF", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST",
      url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/previews",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json",
        "idempotency-key": "preview-intent-0001",
      },
      payload: { expectedVersion: 2, reason: "Curriculum review" },
    });
    expect(response.statusCode, response.payload).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toBe("Cookie");
    expect(materializePreview).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, courseId: "10000000-0000-4000-8000-000000000010",
      expectedVersion: 2, idempotencyKey: "preview-intent-0001",
    }));
    await instance.close();
  });

  it("rejects missing CSRF before the repository and rejects unknown body authority", async () => {
    const instance = await app();
    const csrf = await instance.inject({
      method: "POST", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/previews",
      headers: { cookie: "syntholo_local_staff_session=test", "content-type": "application/json", "idempotency-key": "preview-intent-0002" },
      payload: { expectedVersion: 2, reason: "Review" },
    });
    expect(csrf.statusCode).toBe(403);
    const unknown = await instance.inject({
      method: "POST", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/previews",
      headers: { cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test", "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "preview-intent-0003" },
      payload: { expectedVersion: 2, reason: "Review", reviewerStaffId: actor.staffId },
    });
    expect(unknown.statusCode).toBe(400);
    expect(materializePreview).not.toHaveBeenCalled();
    await instance.close();
  });

  it("publishes only the exact preview/hash/head tuple", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/publications",
      headers: { cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test", "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "publish-intent-0001" },
      payload: { previewId: "10000000-0000-4000-8000-000000000011", expectedManifestHash: "a".repeat(64), expectedHeadRevision: 0, reason: "Approved" },
    });
    expect(response.statusCode, response.payload).toBe(201);
    expect(publishCourse).toHaveBeenCalledWith(expect.objectContaining({
      previewId: "10000000-0000-4000-8000-000000000011",
      expectedManifestHash: "a".repeat(64), expectedHeadRevision: 0,
      idempotencyKey: "publish-intent-0001",
    }));
    await instance.close();
  });

  it("publishes a lesson with durable client idempotency", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/content/lessons/10000000-0000-4000-8000-000000000014/publications",
      headers: { cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test", "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "lesson-publish-0001" },
      payload: { expectedVersion: 2, reason: "Approved lesson" },
    });
    expect(response.statusCode, response.payload).toBe(201);
    expect(publishLesson).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, lessonId: "10000000-0000-4000-8000-000000000014",
      expectedVersion: 2, idempotencyKey: "lesson-publish-0001",
    }));
    await instance.close();
  });

  it("fails closed when the content port returns an extra private field", async () => {
    materializePreview.mockResolvedValueOnce({
      previewId: "10000000-0000-4000-8000-000000000011", manifestHash: "a".repeat(64),
      manifest: { schemaVersion: 1, course: {}, stages: [] }, publicationIssues: [],
      createdAt: "2026-08-14T16:00:00.000Z", privateObjectKey: "secret/transcript.json",
    });
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/previews",
      headers: { cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test", "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "preview-intent-0004" },
      payload: { expectedVersion: 2, reason: "Review" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.payload).not.toContain("secret/transcript.json");
    await instance.close();
  });

  it("fails closed when a publication issue contains an extra private field", async () => {
    materializePreview.mockResolvedValueOnce({
      previewId: "10000000-0000-4000-8000-000000000011", manifestHash: "a".repeat(64),
      manifest: { schemaVersion: 1, course: {}, stages: [] },
      publicationIssues: [{
        code: "VIDEO_NOT_READY", field: "mediaAssetId", lessonId: null,
        providerError: "private provider detail",
      }],
      createdAt: "2026-08-14T16:00:00.000Z",
    });
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/previews",
      headers: { cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test", "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "preview-intent-0005" },
      payload: { expectedVersion: 2, reason: "Review" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.payload).not.toContain("private provider detail");
    await instance.close();
  });

  it.each(["CONTENT_NOT_READY", "MANIFEST_CHANGED", "COURSE_HEAD_CHANGED", "PREVIEW_ALREADY_PUBLISHED", "IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_IN_PROGRESS", "VERSION_CONFLICT", "LESSON_DRAFT_ALREADY_PUBLISHED"] as const)(
    "maps the typed %s database conflict to an exact safe 409",
    async (code) => {
      publishCourse.mockRejectedValueOnce(new ContentCommandConflictError(code));
      const instance = await app();
      const response = await instance.inject({
        method: "POST", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/publications",
        headers: { cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test", "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "publish-conflict-0001" },
        payload: { previewId: "10000000-0000-4000-8000-000000000011", expectedManifestHash: "a".repeat(64), expectedHeadRevision: 0, reason: "Approved" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code } });
      if (code === "IDEMPOTENCY_IN_PROGRESS") expect(response.headers["retry-after"]).toBe("1");
      await instance.close();
    },
  );

  it("returns validated publication drift blockers together without private detail", async () => {
    const publicationIssues = [{
      code: "VIDEO_NOT_READY" as const,
      field: "mediaAssetId",
      lessonId: "10000000-0000-4000-8000-000000000010",
    }];
    publishCourse.mockRejectedValueOnce(new ContentCommandConflictError("CONTENT_NOT_READY", publicationIssues));
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/publications",
      headers: { cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test", "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "publish-drift-0001" },
      payload: { previewId: "10000000-0000-4000-8000-000000000011", expectedManifestHash: "a".repeat(64), expectedHeadRevision: 0, reason: "Approved" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "CONTENT_NOT_READY", details: { publicationIssues } } });
    expect(response.payload).not.toContain("provider");
    await instance.close();
  });

  it("rejects missing or repeated publication idempotency before the content port", async () => {
    const instance = await app();
    const input = { previewId: "10000000-0000-4000-8000-000000000011", expectedManifestHash: "a".repeat(64), expectedHeadRevision: 0, reason: "Approved" };
    const missing = await instance.inject({
      method: "POST", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/publications",
      headers: { cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test", "x-syntholo-csrf": "1", "content-type": "application/json" }, payload: input,
    });
    const repeated = await instance.inject({
      method: "POST", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/publications",
      headers: { cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test", "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": ["publish-intent-0001", "publish-intent-0001"] }, payload: input,
    });
    expect(missing.statusCode).toBe(400);
    expect(repeated.statusCode).toBe(400);
    expect(publishCourse).not.toHaveBeenCalled();
    await instance.close();
  });

  it("keeps an unexpected content failure a safe 500", async () => {
    publishCourse.mockRejectedValueOnce(new Error("postgres://private-content-secret"));
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/publications",
      headers: { cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test", "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "publish-failure-0001" },
      payload: { previewId: "10000000-0000-4000-8000-000000000011", expectedManifestHash: "a".repeat(64), expectedHeadRevision: 0, reason: "Approved" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.payload).not.toContain("private-content-secret");
    await instance.close();
  });
});
