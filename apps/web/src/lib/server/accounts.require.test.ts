import { afterEach, describe, expect, it, vi } from "vitest";
import { AcademyUnavailableError } from "@/lib/db/unavailable";
import { canUseDemoStudent, requireStudentAccount } from "./accounts";

const redirect = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
);
const getNeonAuthUser = vi.hoisted(() => vi.fn());
const getReadyDb = vi.hoisted(() => vi.fn());

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
  ensureAccountForUser: vi.fn(),
  ensureDemoAcademyGrants: vi.fn(),
  ensureStudentWorkspace: vi.fn(),
  listMembershipsForUser: vi.fn(async () => []),
  loadEffectiveAccess: vi.fn(),
  publicIdFromUuid: () => "STU-TEST",
  recordIdentityMigration: vi.fn(),
  setActiveAccount: vi.fn(),
  withSystemScope: vi.fn(async (fn: (db: unknown) => unknown) => fn({})),
}));

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
