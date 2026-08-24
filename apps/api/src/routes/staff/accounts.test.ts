import { staffActor } from "@syntholo/testing";
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

describe("staff accounts routes", () => {
  const list = vi.fn();

  beforeEach(() => {
    list.mockReset().mockResolvedValue([
      {
        accountId: "10000000-0000-4000-8000-000000000004", accountName: "Test Account",
        status: "active", ownerEmail: "owner@example.test", enrolledCourseCount: 1,
      },
    ]);
  });

  async function app() {
    const instance = Fastify({ logger: false, genReqId: () => "40000000-0000-4000-8000-000000000002" });
    await instance.register(requestContextPlugin);
    instance.setErrorHandler(safeErrorHandler);
    const { staffAccountsRoutes } = await import("./accounts.js");
    await instance.register(staffAccountsRoutes, {
      staff: {
        config: { environment: "test", webOrigin: "https://app.syntholo.test" },
        clock: { now: () => new Date("2026-08-14T16:02:00.000Z") },
      },
      accounts: { list },
    } as never);
    return instance;
  }

  it("lists accounts for an admin", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "GET", url: "/staff/accounts",
      headers: { cookie: "syntholo_local_staff_session=test" },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(response.payload) as { accounts: readonly { accountId: string }[] };
    expect(body.accounts).toHaveLength(1);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ actor: trustedActor, query: undefined }));
    await instance.close();
  });

  it("passes a search query through to the repository", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "GET", url: "/staff/accounts?q=owner%40example.test",
      headers: { cookie: "syntholo_local_staff_session=test" },
    });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ query: "owner@example.test" }));
    await instance.close();
  });

  it("rejects a GET request carrying a body", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "GET", url: "/staff/accounts",
      headers: { cookie: "syntholo_local_staff_session=test", "content-type": "application/json" },
      payload: { q: "x" },
    });
    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
    await instance.close();
  });
});
