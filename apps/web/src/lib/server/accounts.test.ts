import { readFileSync } from "node:fs";
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

  it("does not use the demo student in NODE_ENV production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("CLERK_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    expect(canUseDemoStudent()).toBe(false);
  });

  it("keeps the demo student out of the default server module graph", () => {
    const source = readFileSync("src/lib/server/accounts.ts", "utf8");
    expect(source).not.toContain("maria@northstar");
    expect(source).not.toContain("DEMO_STUDENT");
    expect(source).not.toContain("@/lib/demo/data");
    expect(source).not.toContain("@/lib/demo/repository");
    expect(source).toContain('await import("@/lib/demo/student")');
  });
});
