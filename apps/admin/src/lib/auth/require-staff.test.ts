import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminForbiddenError, AdminUnauthenticatedError, requireStaff } from "./staff";

const findStaffByEmail = vi.hoisted(() => vi.fn());
const findStaffByNeonUserId = vi.hoisted(() => vi.fn());
const bindStaffNeonUserId = vi.hoisted(() => vi.fn());
const touchStaffLastSeen = vi.hoisted(() => vi.fn());
const getNeonAuthUser = vi.hoisted(() => vi.fn());
const isNeonAuthConfigured = vi.hoisted(() => vi.fn());
const cloudflareAccessAllows = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "cf-access-jwt-assertion": "token" }),
  cookies: async () => ({ get: () => ({ value: "cookie" }) }),
}));

vi.mock("@syntholo/db", () => ({
  bindStaffNeonUserId,
  findStaffByEmail,
  findStaffByNeonUserId,
  hasPlatformCapability: (role: string, capability: string) => {
    if (role === "super_admin") return true;
    if (role === "support") return capability === "support";
    if (role === "admin") return capability === "content" || capability === "support";
    if (role === "finance") return capability === "billing";
    return false;
  },
  touchStaffLastSeen,
}));

vi.mock("@syntholo/auth/config", () => ({ isNeonAuthConfigured }));
vi.mock("@syntholo/auth/server", () => ({ getNeonAuthUser }));
vi.mock("./access-gate", () => ({ cloudflareAccessAllows }));
vi.mock("./bypass", () => ({ resolveDevBypassEmail: () => undefined }));

function staff(role: "super_admin" | "admin" | "support" | "finance" = "super_admin") {
  return {
    id: "s1",
    publicId: "STF-S1",
    email: "ops@syntholo.com",
    role,
    status: "active" as const,
    neonUserId: "neon_ops",
    createdAt: new Date(),
    lastSeenAt: null,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  cloudflareAccessAllows.mockResolvedValue(true);
  isNeonAuthConfigured.mockReturnValue(true);
});

describe("requireStaff defense in depth", () => {
  it("Case 1: rejects a request that fails Cloudflare Access before looking up identity", async () => {
    vi.stubEnv("NODE_ENV", "production");
    cloudflareAccessAllows.mockResolvedValue(false);
    await expect(requireStaff()).rejects.toBeInstanceOf(AdminForbiddenError);
    expect(getNeonAuthUser).not.toHaveBeenCalled();
    expect(findStaffByNeonUserId).not.toHaveBeenCalled();
  });

  it("Case 3: requires Neon Auth even after Access passes, including for seeded platform_admins", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getNeonAuthUser.mockResolvedValue(null);
    await expect(requireStaff()).rejects.toBeInstanceOf(AdminUnauthenticatedError);
    expect(findStaffByNeonUserId).not.toHaveBeenCalled();
  });

  it("Case 2: rejects a Neon user who is not in platform_admins", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getNeonAuthUser.mockResolvedValue({ id: "neon_contractor", email: "temp@syntholo.com", name: "Temp" });
    findStaffByNeonUserId.mockResolvedValue(null);
    findStaffByEmail.mockResolvedValue(null);
    await expect(requireStaff()).rejects.toBeInstanceOf(AdminForbiddenError);
  });

  it("Case 4: rejects a school admin with a Neon session and no platform_admins row", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getNeonAuthUser.mockResolvedValue({ id: "neon_school_admin", email: "owner@acme.test", name: "Owner" });
    findStaffByNeonUserId.mockResolvedValue(null);
    findStaffByEmail.mockResolvedValue(null);
    await expect(requireStaff()).rejects.toBeInstanceOf(AdminForbiddenError);
  });

  it("Case 5: rejects a support role calling a super-admin-only capability", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getNeonAuthUser.mockResolvedValue({ id: "neon_ops", email: "ops@syntholo.com", name: "Ops" });
    findStaffByNeonUserId.mockResolvedValue(staff("support"));
    await expect(requireStaff("staff")).rejects.toBeInstanceOf(AdminForbiddenError);
  });

  it("Case 6: requireStaff independently enforces Access + Neon + platform role on every call", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getNeonAuthUser.mockResolvedValue({ id: "neon_ops", email: "ops@syntholo.com", name: "Ops" });
    findStaffByNeonUserId.mockResolvedValue(staff("super_admin"));
    await expect(requireStaff("staff")).resolves.toMatchObject({ id: "s1", role: "super_admin" });
    expect(cloudflareAccessAllows).toHaveBeenCalled();
    expect(getNeonAuthUser).toHaveBeenCalled();
    expect(touchStaffLastSeen).toHaveBeenCalledWith("s1");
  });
});
