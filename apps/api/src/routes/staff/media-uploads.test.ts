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

const lessonId = "10000000-0000-4000-8000-000000000030";
const uploadId = "8UPhmY7NDK8sv74CGx5LToQHqQ82DkdA2VDVBNZdjtw";

describe("staff media upload routes", () => {
  const createUpload = vi.fn();
  const finalizeUpload = vi.fn();

  beforeEach(() => {
    createUpload.mockReset().mockResolvedValue({
      uploadId, url: "https://storage.mux.com/upload/8UPhmY7NDK8sv74CGx5LToQHqQ82DkdA2VDVBNZdjtw",
    });
    finalizeUpload.mockReset().mockResolvedValue({
      lessonId, revision: 2, mediaAssetId: "10000000-0000-4000-8000-000000000040", mediaState: "waiting",
    });
  });

  async function app() {
    const instance = Fastify({ logger: false, genReqId: () => "40000000-0000-4000-8000-000000000001" });
    await instance.register(requestContextPlugin);
    instance.setErrorHandler(safeErrorHandler);
    const { staffMediaUploadsRoutes } = await import("./media-uploads.js");
    await instance.register(staffMediaUploadsRoutes, {
      staff: {
        config: { environment: "test", webOrigin: "https://app.syntholo.test" },
        clock: { now: () => new Date("2026-08-14T16:02:00.000Z") },
      },
      mediaUploads: { createUpload, finalizeUpload },
    } as never);
    return instance;
  }

  it("creates an upload URL only for an admin with CSRF and idempotency", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: `/staff/content/lessons/${lessonId}/uploads`,
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json", "idempotency-key": "upload-intent-0001",
      },
      payload: {},
    });
    expect(response.statusCode, response.payload).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.payload)).toEqual({
      uploadId, url: "https://storage.mux.com/upload/8UPhmY7NDK8sv74CGx5LToQHqQ82DkdA2VDVBNZdjtw",
    });
    expect(createUpload).toHaveBeenCalledWith(expect.objectContaining({ actor: trustedActor, lessonId }));
    await instance.close();
  });

  it("rejects missing CSRF before the port", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: `/staff/content/lessons/${lessonId}/uploads`,
      headers: { cookie: "syntholo_local_staff_session=test", "content-type": "application/json", "idempotency-key": "upload-intent-0002" },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(createUpload).not.toHaveBeenCalled();
    await instance.close();
  });

  it("rejects an upload request without an idempotency key", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: `/staff/content/lessons/${lessonId}/uploads`,
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json",
      },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(createUpload).not.toHaveBeenCalled();
    await instance.close();
  });

  it("finalizes an upload by attaching the resulting Mux asset to the lesson", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: `/staff/content/lessons/${lessonId}/uploads/${uploadId}/finalize`,
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json",
      },
      payload: { expectedRevision: 1 },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      lessonId, revision: 2, mediaAssetId: "10000000-0000-4000-8000-000000000040", mediaState: "waiting",
    });
    expect(finalizeUpload).toHaveBeenCalledWith(expect.objectContaining({
      actor: trustedActor, lessonId, uploadId, expectedRevision: 1,
    }));
    await instance.close();
  });

  it("surfaces MUX_UPLOAD_NOT_READY as a 409 when Mux hasn't created the asset yet", async () => {
    finalizeUpload.mockReset().mockRejectedValue(new Error("MUX_UPLOAD_NOT_READY"));
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: `/staff/content/lessons/${lessonId}/uploads/${uploadId}/finalize`,
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json",
      },
      payload: { expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error.code).toBe("MUX_UPLOAD_NOT_READY");
    await instance.close();
  });

  it("surfaces a stale expected revision as VERSION_CONFLICT", async () => {
    finalizeUpload.mockReset().mockRejectedValue(new ContentAuthoringCommandConflictError("VERSION_CONFLICT"));
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: `/staff/content/lessons/${lessonId}/uploads/${uploadId}/finalize`,
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json",
      },
      payload: { expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error.code).toBe("VERSION_CONFLICT");
    await instance.close();
  });

  it("rejects a finalize request body with unknown fields", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST", url: `/staff/content/lessons/${lessonId}/uploads/${uploadId}/finalize`,
      headers: {
        cookie: "syntholo_local_staff_session=test", origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1", "content-type": "application/json",
      },
      payload: { notAField: true },
    });
    expect(response.statusCode).toBe(400);
    expect(finalizeUpload).not.toHaveBeenCalled();
    await instance.close();
  });
});
