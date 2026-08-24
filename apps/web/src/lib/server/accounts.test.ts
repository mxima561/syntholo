import { afterEach, describe, expect, it, vi } from "vitest";
import { canUseDemoStudent, isClerkConfigured } from "./accounts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("student identity gates", () => {
  it("treats Clerk as unconfigured until both keys are present", () => {
    vi.stubEnv("CLERK_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    expect(isClerkConfigured()).toBe(false);
  });

  it("uses the demo student only in demo mode without Clerk", () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("CLERK_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    expect(canUseDemoStudent()).toBe(true);
  });

  it("does not use the demo student when Clerk is configured", () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_clerk");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_clerk");
    expect(canUseDemoStudent()).toBe(false);
  });
});
