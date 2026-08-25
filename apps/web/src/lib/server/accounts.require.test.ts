import { afterEach, describe, expect, it, vi } from "vitest";
import { AcademyUnavailableError } from "@/lib/db/unavailable";
import { canUseDemoStudent, requireStudentAccount } from "./accounts";

const redirect = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
);
const currentUser = vi.hoisted(() => vi.fn());
const getReadyDb = vi.hoisted(() => vi.fn());

vi.mock("react", () => ({
  cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser }));
vi.mock("@/lib/db/client", () => ({ getReadyDb }));
vi.mock("@syntholo/db", () => ({
  ensureAccountForUser: vi.fn(),
  ensureDemoAcademyGrants: vi.fn(),
  ensureStudentWorkspace: vi.fn(),
  loadEffectiveAccess: vi.fn(),
  publicIdFromUuid: () => "STU-TEST",
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
    vi.stubEnv("CLERK_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    expect(canUseDemoStudent()).toBe(false);
    await expect(requireStudentAccount()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(getReadyDb).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/signin");
  });

  it("rethrows database failure when Clerk is configured instead of loading demo student", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_clerk");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_clerk");
    currentUser.mockResolvedValue({
      id: "user_1",
      firstName: "Pat",
      lastName: "Lee",
      primaryEmailAddress: { emailAddress: "pat@example.com" },
    });
    getReadyDb.mockRejectedValue(new Error("DATABASE_URL is not configured"));
    await expect(requireStudentAccount()).rejects.toBeInstanceOf(AcademyUnavailableError);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not redirect to signin when local demo cannot reach the database", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("CLERK_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    getReadyDb.mockRejectedValue(new Error("DATABASE_URL is not configured"));
    expect(canUseDemoStudent()).toBe(true);
    await expect(requireStudentAccount()).rejects.toBeInstanceOf(AcademyUnavailableError);
    expect(redirect).not.toHaveBeenCalled();
  });
});
