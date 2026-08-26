import { describe, expect, it } from "vitest";
import { adminRuntime, cloudflareAccessVerificationRequired } from "./access-runtime";

describe("adminRuntime", () => {
  it("treats Vercel production as production even if other env looks local", () => {
    expect(adminRuntime({ VERCEL_ENV: "production", NODE_ENV: "production" })).toBe("production");
  });

  it("treats Vercel preview as preview despite NODE_ENV=production", () => {
    expect(adminRuntime({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe("preview");
  });

  it("treats next dev as development", () => {
    expect(adminRuntime({ NODE_ENV: "development" })).toBe("development");
  });
});

describe("cloudflareAccessVerificationRequired", () => {
  it("always verifies in production", () => {
    expect(
      cloudflareAccessVerificationRequired({ NODE_ENV: "production", VERCEL_ENV: "production" }),
    ).toBe(true);
  });

  it("skips Access on preview when AUD is unset", () => {
    expect(
      cloudflareAccessVerificationRequired({ NODE_ENV: "production", VERCEL_ENV: "preview" }),
    ).toBe(false);
  });

  it("verifies Access on preview when AUD and team domain are set", () => {
    expect(
      cloudflareAccessVerificationRequired({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        CF_ACCESS_AUD: "aud-tag",
        CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      }),
    ).toBe(true);
  });

  it("skips Access in local development when AUD is unset", () => {
    expect(cloudflareAccessVerificationRequired({ NODE_ENV: "development" })).toBe(false);
  });
});
