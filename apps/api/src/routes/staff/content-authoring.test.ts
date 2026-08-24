import { staffActor } from "@syntholo/testing";
import { ContentAuthoringCommandConflictError } from "@syntholo/database";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestContextPlugin } from "../../plugins/context.js";
import { safeErrorHandler } from "../../plugins/error-handler.js";
import { projectStaffActor } from "../../auth/authorize.js";

const actor = staffActor({
  actorId: "10000000-0000-4000-8000-000000000001",
  staffId: "10000000-0000-4000-8000-000000000001",
  role: "admin",
  permissions: [],
  authenticatedAt: new Date("2026-08-14T16:00:00.000Z"),
});
const trustedActor = projectStaffActor(actor, new Date("2026-08-14T16:00:00.000Z"));

vi.mock("../../auth/staff.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../auth/staff.js")>();
  return { ...original, authenticateStaff: vi.fn(async () => trustedActor) };
});

const blocks = [
  { type: "rich_text", blockId: "body", document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body." }] }] } },
  { type: "action", blockId: "act", title: "Apply it", instructions: "Do the exercise." },
];
const transcript = { schemaVersion: 1, blocks: [{ blockId: "t1", text: "Transcript." }] };

describe("staff content authoring routes", () => {
  const listCourses = vi.fn();
  const createCourseDraft = vi.fn();
  const upsertStageDraft = vi.fn();
  const upsertLessonDraft = vi.fn();
  const recordLessonReview = vi.fn();
  const updateCourseDraft = vi.fn();
  const getCourseDraftTree = vi.fn();

  beforeEach(() => {
    listCourses.mockReset().mockResolvedValue([
      {
        courseId: "10000000-0000-4000-8000-000000000010", slug: "ai-os-academy",
        title: "AI OS Academy", description: "Learn.", revision: 1, published: false,
        createdAt: "2026-08-14T16:00:00.000Z", enrolledCount: 0,
      },
    ]);
    createCourseDraft.mockReset().mockResolvedValue({
      courseId: "10000000-0000-4000-8000-000000000010", slug: "ai-os-academy",
      title: "AI OS Academy", description: "Learn.", revision: 1,
      createdAt: "2026-08-14T16:00:00.000Z",
    });
    upsertStageDraft.mockReset().mockResolvedValue({
      stageId: "10000000-0000-4000-8000-000000000020", courseId: "10000000-0000-4000-8000-000000000010",
      slug: "diagnose", title: "Diagnose", description: "Stage.", order: 1, revision: 1,
    });
    upsertLessonDraft.mockReset().mockResolvedValue({
      lessonId: "10000000-0000-4000-8000-000000000030", courseId: "10000000-0000-4000-8000-000000000010",
      stageId: "10000000-0000-4000-8000-000000000020", slug: "diagnose-1", revision: 1,
      mediaAssetId: "10000000-0000-4000-8000-000000000040", order: 1, required: true,
    });
    recordLessonReview.mockReset().mockResolvedValue({
      lessonId: "10000000-0000-4000-8000-000000000030", draftRevision: 1,
      draftHash: "a".repeat(64), accessibilityDecisionId: "10000000-0000-4000-8000-000000000050",
      disclosureDecisionId: "10000000-0000-4000-8000-000000000051",
    });
    updateCourseDraft.mockReset().mockResolvedValue({
      courseId: "10000000-0000-4000-8000-000000000010",
      title: "Updated title", description: "Updated description.", revision: 2,
    });
    getCourseDraftTree.mockReset().mockResolvedValue({
      courseId: "10000000-0000-4000-8000-000000000010", slug: "ai-os-academy",
      title: "AI OS Academy", description: "Learn.", revision: 1,
      stages: [{
        stageId: "10000000-0000-4000-8000-000000000020", slug: "diagnose",
        title: "Diagnose", description: "Stage.", order: 1, revision: 1,
        lessons: [{
          lessonId: "10000000-0000-4000-8000-000000000030", slug: "diagnose-1",
          title: "Diagnose 1", summary: "Summary.", durationSeconds: 360,
          blocks, transcript, order: 1, required: true, revision: 1,
        }],
      }],
    });
  });

  async function app() {
    const instance = Fastify({ logger: false, genReqId: () => "40000000-0000-4000-8000-000000000001" });
    await instance.register(requestContextPlugin);
    instance.setErrorHandler(safeErrorHandler);
    const { staffContentAuthoringRoutes } = await import("./content-authoring.js");
    await instance.register(staffContentAuthoringRoutes, {
      staff: {
        config: { environment: "test", webOrigin: "https://app.syntholo.test" },
        clock: { now: () => new Date("2026-08-14T16:02:00.000Z") },
      },
      contentAuthoring: {
        listCourses, createCourseDraft, upsertStageDraft, upsertLessonDraft, recordLessonReview,
        updateCourseDraft, getCourseDraftTree,
      },
    } as never);
    return instance;
  }

  it("creates a course draft only for an admin with CSRF and idempotency", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/content/courses",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "course-intent-0001",
      },
      payload: { slug: "ai-os-academy", title: "AI OS Academy", description: "Learn." },
    });
    expect(response.statusCode, response.payload).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(createCourseDraft).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, slug: "ai-os-academy", title: "AI OS Academy",
      description: "Learn.", idempotencyKey: "course-intent-0001",
    }));
    await instance.close();
  });

  it("rejects missing CSRF before the repository", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/content/courses",
      headers: { cookie: "syntholo_local_staff_session=test", "content-type": "application/json", "idempotency-key": "course-intent-0002" },
      payload: { slug: "ai-os-academy", title: "AI OS Academy", description: "Learn." },
    });
    expect(response.statusCode).toBe(403);
    expect(createCourseDraft).not.toHaveBeenCalled();
    await instance.close();
  });

  it("upserts a stage draft with the expected course revision", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/stages",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "stage-intent-0001",
      },
      payload: { expectedCourseRevision: 1, slug: "diagnose", title: "Diagnose", description: "Stage.", order: 1 },
    });
    expect(response.statusCode, response.payload).toBe(201);
    expect(upsertStageDraft).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, courseId: "10000000-0000-4000-8000-000000000010",
      expectedCourseRevision: 1, slug: "diagnose", order: 1, idempotencyKey: "stage-intent-0001",
    }));
    await instance.close();
  });

  it("upserts a lesson draft with blocks and transcript", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST",
      url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/stages/10000000-0000-4000-8000-000000000020/lessons",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "lesson-intent-0001",
      },
      payload: {
        stageId: "10000000-0000-4000-8000-000000000020",
        slug: "diagnose-1", title: "Diagnose 1", summary: "Summary.", durationSeconds: 360,
        blocks, transcript, order: 1, required: true,
      },
    });
    expect(response.statusCode, response.payload).toBe(201);
    expect(upsertLessonDraft).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, courseId: "10000000-0000-4000-8000-000000000010",
      stageId: "10000000-0000-4000-8000-000000000020", slug: "diagnose-1", durationSeconds: 360,
      idempotencyKey: "lesson-intent-0001",
    }));
    await instance.close();
  });

  it("rejects a lesson draft with duration outside 300-720", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST",
      url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/stages/10000000-0000-4000-8000-000000000020/lessons",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "lesson-intent-0002",
      },
      payload: {
        stageId: "10000000-0000-4000-8000-000000000020",
        slug: "diagnose-2", title: "Diagnose 2", summary: "Summary.", durationSeconds: 60,
        blocks, transcript, order: 2, required: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(upsertLessonDraft).not.toHaveBeenCalled();
    await instance.close();
  });

  it("records a lesson review", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/content/lessons/10000000-0000-4000-8000-000000000030/review",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json",
      },
      payload: { expectedRevision: 1, reason: "Local dev stub review." },
    });
    expect(response.statusCode, response.payload).toBe(201);
    expect(recordLessonReview).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, lessonId: "10000000-0000-4000-8000-000000000030",
      expectedRevision: 1, reason: "Local dev stub review.",
    }));
    await instance.close();
  });

  it("updates a course draft with CSRF and idempotency", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "PATCH", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "update-course-0001",
      },
      payload: { expectedRevision: 1, title: "Updated title", description: "Updated description." },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(updateCourseDraft).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, courseId: "10000000-0000-4000-8000-000000000010",
      expectedRevision: 1, title: "Updated title", description: "Updated description.",
      idempotencyKey: "update-course-0001",
    }));
    await instance.close();
  });

  it("rejects updating a course draft without CSRF before the repository", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "PATCH", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010",
      headers: { cookie: "syntholo_local_staff_session=test", "content-type": "application/json", "idempotency-key": "update-course-0002" },
      payload: { expectedRevision: 1, title: "Updated title", description: "Updated description." },
    });
    expect(response.statusCode).toBe(403);
    expect(updateCourseDraft).not.toHaveBeenCalled();
    await instance.close();
  });

  it("reads a course's live draft tree", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "GET", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010",
      headers: { cookie: "syntholo_local_staff_session=test" },
    });
    expect(response.statusCode, response.payload).toBe(200);
    const body = JSON.parse(response.payload) as { stages: readonly { lessons: readonly unknown[] }[] };
    expect(body.stages).toHaveLength(1);
    expect(body.stages[0]?.lessons).toHaveLength(1);
    expect(getCourseDraftTree).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, courseId: "10000000-0000-4000-8000-000000000010",
    }));
    await instance.close();
  });

  it("lists courses for an admin without CSRF", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "GET", url: "/staff/content/courses",
      headers: { cookie: "syntholo_local_staff_session=test" },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(response.payload) as { courses: readonly { courseId: string }[] };
    expect(body.courses).toHaveLength(1);
    expect(listCourses).toHaveBeenCalledWith(expect.objectContaining({ actor: trustedActor }));
    await instance.close();
  });

  it("patches a stage draft with CSRF and the stage id", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "PATCH", url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/stages/10000000-0000-4000-8000-000000000020",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "stage-intent-0002",
      },
      payload: { expectedCourseRevision: 1, slug: "diagnose", title: "Diagnose", description: "Stage.", order: 1 },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(upsertStageDraft).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, courseId: "10000000-0000-4000-8000-000000000010",
      stageId: "10000000-0000-4000-8000-000000000020", expectedCourseRevision: 1,
      idempotencyKey: "stage-intent-0002",
    }));
    await instance.close();
  });

  it("patches a lesson draft with CSRF and the lesson id", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "PATCH",
      url: "/staff/content/courses/10000000-0000-4000-8000-000000000010/stages/10000000-0000-4000-8000-000000000020/lessons/10000000-0000-4000-8000-000000000030",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "lesson-intent-0003",
      },
      payload: {
        stageId: "10000000-0000-4000-8000-000000000020",
        slug: "diagnose-1", title: "Diagnose 1", summary: "Summary.", durationSeconds: 360,
        blocks, transcript, order: 1, required: true,
      },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(upsertLessonDraft).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, courseId: "10000000-0000-4000-8000-000000000010",
      stageId: "10000000-0000-4000-8000-000000000020",
      lessonId: "10000000-0000-4000-8000-000000000030",
      idempotencyKey: "lesson-intent-0003",
    }));
    await instance.close();
  });

  it("maps a repository conflict to a 409", async () => {
    createCourseDraft.mockRejectedValueOnce(new ContentAuthoringCommandConflictError("CONTENT_SLUG_TAKEN"));
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/content/courses",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "course-intent-0003",
      },
      payload: { slug: "ai-os-academy", title: "AI OS Academy", description: "Learn." },
    });
    expect(response.statusCode).toBe(409);
    await instance.close();
  });
});
