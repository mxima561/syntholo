import { describe, expect, it, vi } from "vitest";
import { resolveProductionAdminAccess } from "./staff-access";

const staffActor = {
  kind: "staff",
  actorId: "10000000-0000-4000-8000-000000000001",
  workosUserId: "user_workos_1",
  staffId: "20000000-0000-4000-8000-000000000002",
  role: "admin",
  permissions: ["content:read", "operations:read"],
  authenticatedAt: "2026-08-14T12:00:00.000Z",
} as const;

function resolve(response: Response) {
  return resolveProductionAdminAccess({
    apiUpstreamOrigin: "https://api.syntholo.test",
    cookieName: "__Host-syntholo_staff_session",
    cookieStore: { getAll: () => [{ value: "x".repeat(43) }] },
    fetch: vi.fn(async () => response),
  });
}

describe("production staff access", () => {
  it("accepts a valid API-resolved WorkOS administrator", async () => {
    await expect(resolve(new Response(JSON.stringify(staffActor), { status: 200 })))
      .resolves.toBe("authorized");
  });

  it("does not authorize a valid WorkOS coach for the admin surface", async () => {
    await expect(resolve(new Response(JSON.stringify({ ...staffActor, role: "coach" }), {
      status: 200,
    }))).resolves.toBe("forbidden");
  });

  it("fails closed for an invalid or missing staff cookie", async () => {
    await expect(resolveProductionAdminAccess({
      apiUpstreamOrigin: "https://api.syntholo.test",
      cookieName: "__Host-syntholo_staff_session",
      cookieStore: { getAll: () => [] },
      fetch: vi.fn(),
    })).resolves.toBe("unauthenticated");
  });

  it("distinguishes an expired session from an unavailable upstream", async () => {
    await expect(resolve(new Response(null, { status: 401 })))
      .resolves.toBe("unauthenticated");
    await expect(resolve(new Response(null, { status: 503 })))
      .resolves.toBe("unavailable");
  });

  it("treats a malformed successful actor response as unavailable", async () => {
    await expect(resolve(new Response(JSON.stringify({ role: "admin" }), { status: 200 })))
      .resolves.toBe("unavailable");
  });
});
