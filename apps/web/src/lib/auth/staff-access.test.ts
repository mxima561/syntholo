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

function resolve(actor: unknown) {
  return resolveProductionAdminAccess({
    apiUpstreamOrigin: "https://api.syntholo.test",
    cookieName: "__Host-syntholo_staff_session",
    cookieStore: { getAll: () => [{ value: "x".repeat(43) }] },
    fetch: vi.fn(async () => new Response(JSON.stringify(actor), { status: 200 })),
  });
}

describe("production staff access", () => {
  it("accepts a valid API-resolved WorkOS administrator", async () => {
    await expect(resolve(staffActor)).resolves.toBe(true);
  });

  it("does not authorize a valid WorkOS coach for the admin surface", async () => {
    await expect(resolve({ ...staffActor, role: "coach" })).resolves.toBe(false);
  });

  it("fails closed for an invalid or missing staff cookie", async () => {
    await expect(resolveProductionAdminAccess({
      apiUpstreamOrigin: "https://api.syntholo.test",
      cookieName: "__Host-syntholo_staff_session",
      cookieStore: { getAll: () => [] },
      fetch: vi.fn(),
    })).resolves.toBe(false);
  });
});
