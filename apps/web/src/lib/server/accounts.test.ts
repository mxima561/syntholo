import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNeonAuthConfigured } from "@syntholo/auth/config";
import { canUseDemoStudent } from "./accounts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("student identity gates", () => {
  it("treats Neon Auth as unconfigured until base URL and cookie secret are present", () => {
    vi.stubEnv("NEON_AUTH_BASE_URL", "");
    vi.stubEnv("NEON_AUTH_COOKIE_SECRET", "");
    expect(isNeonAuthConfigured()).toBe(false);
  });

  it("uses the demo student only in demo mode without Neon Auth", () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("NEON_AUTH_BASE_URL", "");
    vi.stubEnv("NEON_AUTH_COOKIE_SECRET", "");
    expect(canUseDemoStudent()).toBe(true);
  });

  it("does not use the demo student when Neon Auth is configured", () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.neon.example/auth");
    vi.stubEnv("NEON_AUTH_COOKIE_SECRET", "n".repeat(32));
    expect(canUseDemoStudent()).toBe(false);
  });

  it("does not use the demo student in NODE_ENV production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("NEON_AUTH_BASE_URL", "");
    vi.stubEnv("NEON_AUTH_COOKIE_SECRET", "");
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
