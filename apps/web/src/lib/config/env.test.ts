import { describe, expect, it } from "vitest";
import { parseRuntimeEnv } from "./env";

describe("parseRuntimeEnv", () => {
  it("allows demo mode without vendor credentials", () => {
    expect(parseRuntimeEnv({ APP_MODE: "demo" })).toMatchObject({ mode: "demo", vendorsConfigured: false });
  });

  it("never silently defaults a production Node runtime to demo mode", () => {
    expect(() => parseRuntimeEnv({ NODE_ENV: "production" })).toThrow(
      /configured explicitly/i,
    );
  });

  it("rejects a partial Stripe configuration", () => {
    expect(() => parseRuntimeEnv({ APP_MODE: "demo", STRIPE_SECRET_KEY: "sk_test_partial" })).toThrow(/stripe/i);
  });

  it("requires every production integration", () => {
    expect(() => parseRuntimeEnv({ APP_MODE: "production" })).toThrow(/production/i);
  });
});
