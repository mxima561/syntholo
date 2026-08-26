import { afterEach, describe, expect, it, vi } from "vitest";
import { AcademyUnavailableError } from "@/lib/db/unavailable";
import { canUseDemoStudent, requireStudentAccount, resolveAcademyEntitlements, type Account } from "./accounts";

const redirect = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
);
const getNeonAuthUser = vi.hoisted(() => vi.fn());
const getReadyDb = vi.hoisted(() => vi.fn());
const claimPaidPurchasesForUser = vi.hoisted(() => vi.fn());
const ensureStaffAcademyGrants = vi.hoisted(() => vi.fn());
const isActiveStaffIdentity = vi.hoisted(() => vi.fn());
const loadEffectiveAccess = vi.hoisted(() => vi.fn());

vi.mock("react", () => ({
  cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@syntholo/auth/server", () => ({ getNeonAuthUser }));
vi.mock("@syntholo/auth/config", () => ({
  isNeonAuthConfigured: () =>
    Boolean(process.env.NEON_AUTH_BASE_URL?.trim() && process.env.NEON_AUTH_COOKIE_SECRET?.trim()),
}));
vi.mock("@/lib/db/client", () => ({ getReadyDb }));
vi.mock("@syntholo/db", () => ({
  claimPaidPurchasesForUser,
  ensureAccountForUser: vi.fn(),
  ensureDemoAcademyGrants: vi.fn(),
  ensureStaffAcademyGrants,
  ensureStudentWorkspace: vi.fn(),
  isActiveStaffIdentity,
  listMembershipsForUser: vi.fn(async () => []),
  loadEffectiveAccess,
  publicIdFromUuid: () => "STU-TEST",
  recordIdentityMigration: vi.fn(),
  setActiveAccount: vi.fn(),
  withSystemScope: vi.fn(async (fn: (db: unknown) => unknown) => fn({})),
}));

const member: Account = {
  id: "user_1",
  neonUserId: "neon_1",
  accountId: "acct_1",
  membershipId: "mem_1",
  membershipRole: "owner",
  memberships: [],
  publicId: "STU-TEST",
  email: "pat@example.com",
  firstName: "Pat",
  lastName: "Lee",
  businessName: "",
  jobTitle: "",
  timezone: "America/New_York",
  role: "student",
  initials: "PL",
};

function access(academyCourse: boolean) {
  return { capabilities: { academy_course: academyCourse } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("requireStudentAccount fail-closed", () => {
  it("never provisions the demo student when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("NEON_AUTH_BASE_URL", "");
    vi.stubEnv("NEON_AUTH_COOKIE_SECRET", "");
    expect(canUseDemoStudent()).toBe(false);
    await expect(requireStudentAccount()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(getReadyDb).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/signin");
  });

  it("rethrows database failure when Neon Auth is configured instead of loading demo student", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.neon.example/auth");
    vi.stubEnv("NEON_AUTH_COOKIE_SECRET", "n".repeat(32));
    getNeonAuthUser.mockResolvedValue({
      id: "user_1",
      email: "pat@example.com",
      name: "Pat Lee",
    });
    getReadyDb.mockRejectedValue(new Error("DATABASE_URL is not configured"));
    await expect(requireStudentAccount()).rejects.toBeInstanceOf(AcademyUnavailableError);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not redirect to signin when local demo cannot reach the database", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("NEON_AUTH_BASE_URL", "");
    vi.stubEnv("NEON_AUTH_COOKIE_SECRET", "");
    getReadyDb.mockRejectedValue(new Error("DATABASE_URL is not configured"));
    expect(canUseDemoStudent()).toBe(true);
    await expect(requireStudentAccount()).rejects.toBeInstanceOf(AcademyUnavailableError);
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("resolveAcademyEntitlements", () => {
  it("attaches a guest purchase to the signed-in email before sending anyone to pricing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.neon.example/auth");
    vi.stubEnv("NEON_AUTH_COOKIE_SECRET", "n".repeat(32));
    loadEffectiveAccess.mockResolvedValueOnce(access(false)).mockResolvedValueOnce(access(true));
    claimPaidPurchasesForUser.mockResolvedValue(1);
    const result = await resolveAcademyEntitlements(member);
    expect(claimPaidPurchasesForUser).toHaveBeenCalledWith("user_1", "pat@example.com");
    expect(result.capabilities.academy_course).toBe(true);
    expect(ensureStaffAcademyGrants).not.toHaveBeenCalled();
  });

  it("lets active staff preview the academy when they have no purchase", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.neon.example/auth");
    vi.stubEnv("NEON_AUTH_COOKIE_SECRET", "n".repeat(32));
    loadEffectiveAccess
      .mockResolvedValueOnce(access(false))
      .mockResolvedValueOnce(access(false))
      .mockResolvedValueOnce(access(true));
    claimPaidPurchasesForUser.mockResolvedValue(0);
    isActiveStaffIdentity.mockResolvedValue(true);
    const result = await resolveAcademyEntitlements(member);
    expect(ensureStaffAcademyGrants).toHaveBeenCalledWith("acct_1", "user_1");
    expect(result.capabilities.academy_course).toBe(true);
  });

  it("does not invent academy access for an unpaid visitor", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.neon.example/auth");
    vi.stubEnv("NEON_AUTH_COOKIE_SECRET", "n".repeat(32));
    loadEffectiveAccess.mockResolvedValue(access(false));
    claimPaidPurchasesForUser.mockResolvedValue(0);
    isActiveStaffIdentity.mockResolvedValue(false);
    const result = await resolveAcademyEntitlements(member);
    expect(result.capabilities.academy_course).toBe(false);
    expect(ensureStaffAcademyGrants).not.toHaveBeenCalled();
  });
});
