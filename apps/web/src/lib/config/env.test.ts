import { describe, expect, it } from "vitest";
import { parseRuntimeEnv } from "./env";

describe("parseRuntimeEnv", () => {
  it("allows demo mode without vendor credentials", () => {
    expect(parseRuntimeEnv({ APP_MODE: "demo" })).toMatchObject({ mode: "demo", vendorsConfigured: false });
  });

  it("rejects a partial Clerk configuration", () => {
    expect(() => parseRuntimeEnv({ APP_MODE: "demo", CLERK_SECRET_KEY: "sk_test_partial" })).toThrow(/clerk/i);
  });

  it("requires production keys when APP_MODE is production", () => {
    expect(() => parseRuntimeEnv({ APP_MODE: "production" })).toThrow(/production/i);
  });

  it("allows production with DATABASE_URL, Clerk, and Stripe even without Mux or HighLevel", () => {
    const env = parseRuntimeEnv({
      APP_MODE: "production",
      DATABASE_URL: "postgres://localhost/syntholo",
      CLERK_SECRET_KEY: "sk_test_clerk",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_clerk",
      STRIPE_SECRET_KEY: "sk_test_stripe",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    });
    expect(env).toMatchObject({
      mode: "production",
      vendorsConfigured: true,
      databaseUrl: "postgres://localhost/syntholo",
    });
    expect(env).not.toHaveProperty("mongodb");
    expect(env).not.toHaveProperty("highlevel");
    expect(env.mux).toBeUndefined();
  });
});
