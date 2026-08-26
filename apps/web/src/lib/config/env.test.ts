import { describe, expect, it } from "vitest";
import { parseRuntimeEnv } from "./env";

const neon = {
  NEON_AUTH_BASE_URL: "https://auth.neon.example/auth",
  NEON_AUTH_COOKIE_SECRET: "n".repeat(32),
  NEXT_PUBLIC_NEON_AUTH_URL: "https://auth.neon.example/auth",
  NEXT_PUBLIC_NEON_DATA_API_URL: "https://api.neon.example/rest/v1",
};

describe("parseRuntimeEnv", () => {
  it("allows demo mode without vendor credentials", () => {
    expect(parseRuntimeEnv({ APP_MODE: "demo" })).toMatchObject({ mode: "demo", vendorsConfigured: false });
  });

  it("rejects a partial Neon Auth configuration", () => {
    expect(() => parseRuntimeEnv({ APP_MODE: "demo", NEON_AUTH_BASE_URL: "https://auth.neon.example/auth" })).toThrow(/neon auth/i);
  });

  it("requires production keys when APP_MODE is production", () => {
    expect(() => parseRuntimeEnv({ APP_MODE: "production" })).toThrow(/production/i);
  });

  it("allows production with DATABASE_URL, Neon Auth, Data API, and Stripe even without Mux", () => {
    const env = parseRuntimeEnv({
      APP_MODE: "production",
      DATABASE_URL: "postgres://localhost/syntholo",
      ...neon,
      STRIPE_SECRET_KEY: "sk_test_stripe",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    });
    expect(env).toMatchObject({
      mode: "production",
      vendorsConfigured: true,
      databaseUrl: "postgres://localhost/syntholo",
    });
    expect(env.neonAuth?.baseUrl).toBe(neon.NEON_AUTH_BASE_URL);
    expect(env.mux).toBeUndefined();
  });

  it("accepts Stripe restricted sandbox keys", () => {
    const env = parseRuntimeEnv({
      APP_MODE: "production",
      DATABASE_URL: "postgres://localhost/syntholo",
      ...neon,
      STRIPE_SECRET_KEY: "rkcs_test_restrictedsandboxkey",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    });
    expect(env.stripe?.secretKey).toBe("rkcs_test_restrictedsandboxkey");
  });
});
