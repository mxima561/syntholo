import { describe, expect, it } from "vitest";
import { parseRuntimeEnv } from "./env";

describe("parseRuntimeEnv", () => {
  it("allows demo mode without vendor credentials", () => {
    expect(parseRuntimeEnv({ APP_MODE: "demo" })).toMatchObject({ mode: "demo", vendorsConfigured: false });
  });

  it("rejects a partial Clerk configuration", () => {
    expect(() => parseRuntimeEnv({ APP_MODE: "demo", CLERK_SECRET_KEY: "sk_test_partial" })).toThrow(/clerk/i);
  });

  it("requires every production integration", () => {
    expect(() => parseRuntimeEnv({ APP_MODE: "production" })).toThrow(/production/i);
  });
});
