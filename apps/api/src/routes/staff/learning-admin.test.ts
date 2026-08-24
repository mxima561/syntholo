import { staffActor } from "@syntholo/testing";
import { LearningAdminCommandConflictError } from "@syntholo/database";
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

describe("staff learning admin routes", () => {
  const grantEnrollment = vi.fn();

  beforeEach(() => {
    grantEnrollment.mockReset().mockResolvedValue({
      enrollmentId: "10000000-0000-4000-8000-000000000060",
      accountId: "10000000-0000-4000-8000-000000000070",
      courseId: "10000000-0000-4000-8000-000000000010",
      courseVersionId: "10000000-0000-4000-8000-000000000080",
      enrolledAt: "2026-08-14T16:00:00.000Z",
    });
  });

  async function app() {
    const instance = Fastify({ logger: false, genReqId: () => "40000000-0000-4000-8000-000000000001" });
    await instance.register(requestContextPlugin);
    instance.setErrorHandler(safeErrorHandler);
    const { staffLearningAdminRoutes } = await import("./learning-admin.js");
    await instance.register(staffLearningAdminRoutes, {
      staff: {
        config: { environment: "test", webOrigin: "https://app.syntholo.test" },
        clock: { now: () => new Date("2026-08-14T16:02:00.000Z") },
      },
      learningAdmin: { grantEnrollment },
    } as never);
    return instance;
  }

  it("grants an enrollment only for an admin with CSRF and idempotency", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/learning/enrollments",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "enroll-intent-0001",
      },
      payload: {
        accountId: "10000000-0000-4000-8000-000000000070",
        courseId: "10000000-0000-4000-8000-000000000010",
        reason: "Local admin grant.",
      },
    });
    expect(response.statusCode, response.payload).toBe(201);
    expect(grantEnrollment).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor,
      accountId: "10000000-0000-4000-8000-000000000070",
      courseId: "10000000-0000-4000-8000-000000000010",
      idempotencyKey: "enroll-intent-0001",
    }));
    await instance.close();
  });

  it("rejects missing CSRF before the repository", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/learning/enrollments",
      headers: { cookie: "syntholo_local_staff_session=test", "content-type": "application/json", "idempotency-key": "enroll-intent-0002" },
      payload: {
        accountId: "10000000-0000-4000-8000-000000000070",
        courseId: "10000000-0000-4000-8000-000000000010",
        reason: "Local admin grant.",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(grantEnrollment).not.toHaveBeenCalled();
    await instance.close();
  });

  it("maps a repository conflict to a 409", async () => {
    grantEnrollment.mockRejectedValueOnce(new LearningAdminCommandConflictError("LEARNING_ADMIN_ALREADY_ENROLLED"));
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: "/staff/learning/enrollments",
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "enroll-intent-0003",
      },
      payload: {
        accountId: "10000000-0000-4000-8000-000000000070",
        courseId: "10000000-0000-4000-8000-000000000010",
        reason: "Local admin grant.",
      },
    });
    expect(response.statusCode).toBe(409);
    await instance.close();
  });
});
