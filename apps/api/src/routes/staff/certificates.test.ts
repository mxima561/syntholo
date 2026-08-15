import { staffActor } from "@syntholo/testing";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectStaffActor } from "../../auth/authorize.js";
import { requestContextPlugin } from "../../plugins/context.js";
import { safeErrorHandler } from "../../plugins/error-handler.js";

const certificateId = "10000000-0000-4000-8000-000000000001";
const correlationId = "10000000-0000-4000-8000-000000000002";
const actor = staffActor({
  actorId: "10000000-0000-4000-8000-000000000003",
  staffId: "10000000-0000-4000-8000-000000000003",
  role: "admin",
  permissions: ["certificates:deliver"],
  authenticatedAt: new Date("2026-08-15T12:00:00.000Z"),
});
const trustedActor = projectStaffActor(actor, new Date("2026-08-15T12:00:00.000Z"));

vi.mock("../../auth/staff.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../auth/staff.js")>();
  return { ...original, authenticateStaff: vi.fn(async () => trustedActor) };
});

describe("staff certificate delivery route", () => {
  const createDelivery = vi.fn();

  beforeEach(() => {
    createDelivery.mockReset().mockResolvedValue({ status: "delivery_pending" });
  });

  async function app() {
    const instance = Fastify({
      logger: false,
      genReqId: () => correlationId,
    });
    await instance.register(requestContextPlugin);
    instance.setErrorHandler(safeErrorHandler);
    const { staffCertificateRoutes } = await import("./certificates.js");
    await instance.register(staffCertificateRoutes, {
      staff: {
        config: { environment: "test", webOrigin: "https://app.syntholo.test" },
        clock: { now: () => new Date("2026-08-15T12:02:00.000Z") },
      },
      certificates: { createDelivery },
    } as never);
    return instance;
  }

  it("creates only an attributed pending staff delivery after R5, admin, permission, CSRF, and idempotency", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST",
      url: `/staff/certificates/${certificateId}/deliveries`,
      headers: {
        cookie: "syntholo_local_staff_session=test",
        origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1",
        "x-correlation-id": correlationId,
        "content-type": "application/json",
        "idempotency-key": "certificate-delivery-intent-0001",
      },
      payload: { reason: "Customer requested recovery" },
    });
    expect(response.statusCode, response.payload).toBe(202);
    expect(response.json()).toEqual({ status: "delivery_pending" });
    expect(response.headers).toMatchObject({ "cache-control": "no-store", vary: "Cookie" });
    expect(createDelivery).toHaveBeenCalledWith(
      trustedActor,
      correlationId,
      certificateId,
      { reason: "Customer requested recovery" },
      "certificate-delivery-intent-0001",
    );
    await instance.close();
  });

  it("rejects unsafe command shapes before the repository and exposes no implicit HEAD or GET", async () => {
    const instance = await app();
    const common = {
      cookie: "syntholo_local_staff_session=test",
      origin: "https://app.syntholo.test",
      "x-syntholo-csrf": "1",
      "content-type": "application/json",
      "idempotency-key": "certificate-delivery-intent-0002",
    };
    const withoutCsrf = {
      cookie: common.cookie,
      origin: common.origin,
      "content-type": common["content-type"],
      "idempotency-key": common["idempotency-key"],
    };
    for (const request of [
      { headers: withoutCsrf, payload: { reason: "Customer request" } },
      { headers: common, payload: { reason: "Customer request", destination: "private@example.test" } },
      { headers: { ...common, "idempotency-key": "contains/slash-key" }, payload: { reason: "Customer request" } },
    ]) {
      const response = await instance.inject({
        method: "POST",
        url: `/staff/certificates/${certificateId}/deliveries`,
        headers: request.headers as never,
        payload: request.payload,
      });
      expect([400, 403]).toContain(response.statusCode);
    }
    expect((await instance.inject({ method: "HEAD", url: `/staff/certificates/${certificateId}/deliveries` })).statusCode).toBe(404);
    expect((await instance.inject({ method: "GET", url: `/staff/certificates/${certificateId}/deliveries` })).statusCode).toBe(404);
    expect(createDelivery).not.toHaveBeenCalled();
    await instance.close();
  });
});
