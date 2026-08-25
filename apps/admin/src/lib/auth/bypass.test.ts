import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProductionBypassDisabled, resolveDevBypassEmail } from "./bypass";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("assertProductionBypassDisabled", () => {
  it("throws when a production build has ADMIN_DEV_BYPASS_EMAIL set", () => {
    expect(() =>
      assertProductionBypassDisabled({ NODE_ENV: "production", ADMIN_DEV_BYPASS_EMAIL: "ops@syntholo.com" }),
    ).toThrow(/ADMIN_DEV_BYPASS_EMAIL must not be set outside local development/);
  });

  it("throws when a Vercel preview build has ADMIN_DEV_BYPASS_EMAIL set", () => {
    expect(() =>
      assertProductionBypassDisabled({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        ADMIN_DEV_BYPASS_EMAIL: "ops@syntholo.com",
      }),
    ).toThrow(/ADMIN_DEV_BYPASS_EMAIL must not be set outside local development/);
  });

  it("allows production when the bypass env is unset", () => {
    expect(() => assertProductionBypassDisabled({ NODE_ENV: "production" })).not.toThrow();
  });
});

describe("resolveDevBypassEmail", () => {
  it("returns the bypass email only when not production and Access AUD is unset", () => {
    expect(
      resolveDevBypassEmail({ NODE_ENV: "development", ADMIN_DEV_BYPASS_EMAIL: "ops@syntholo.com" }),
    ).toBe("ops@syntholo.com");
  });

  it("ignores the bypass when CF_ACCESS_AUD is set", () => {
    expect(
      resolveDevBypassEmail({
        NODE_ENV: "development",
        ADMIN_DEV_BYPASS_EMAIL: "ops@syntholo.com",
        CF_ACCESS_AUD: "aud-tag",
      }),
    ).toBeUndefined();
  });

  it("throws if the bypass path is invoked in production", () => {
    expect(() =>
      resolveDevBypassEmail({ NODE_ENV: "production", ADMIN_DEV_BYPASS_EMAIL: "ops@syntholo.com" }),
    ).toThrow(/not reachable outside local development/);
  });
});
