import { describe, expect, it, vi } from "vitest";
import {
  createMemberApiClient,
  createStaffApiClient,
  createServerStaffApiClient,
} from "./client.js";
import { parseWebApiConfig } from "./config.js";

describe("web API boundary", () => {
  it("uses a relative bearer-only member request with omitted credentials", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createMemberApiClient({
      getToken: async () => "clerk-session-token",
      fetch: fetcher,
    });

    await client("/v1/member/whoami");

    expect(fetcher).toHaveBeenCalledWith("/v1/member/whoami", {
      cache: "no-store",
      credentials: "omit",
      headers: { authorization: "Bearer clerk-session-token" },
    });
  });

  it("uses a separate same-origin staff client without token access", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createStaffApiClient({ fetch: fetcher });

    await client("/v1/staff/whoami", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", "x-syntholo-csrf": "1" },
    });

    expect(fetcher).toHaveBeenCalledWith("/v1/staff/whoami", {
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-syntholo-csrf": "1",
      },
      method: "POST",
    });
  });

  it("closes server calls over one validated canonical opaque cookie", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createServerStaffApiClient({
      apiUpstreamOrigin: "https://api.internal.test",
      cookieName: "__Host-syntholo_staff_session",
      fetch: fetcher,
    });
    const cookie = "x".repeat(43);
    await client("/v1/staff/whoami", {
      getAll: () => [{ value: cookie }],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.internal.test/v1/staff/whoami",
      expect.objectContaining({
        headers: { cookie: `__Host-syntholo_staff_session=${cookie}` },
      }),
    );
    await expect(
      client("/v1/staff/whoami", {
        getAll: () => [{ value: cookie }, { value: cookie }],
      }),
    ).rejects.toThrow("WEB_STAFF_COOKIE_INVALID");
  });

  it("allows the distinct local cookie only with a validated HTTP(S) upstream", () => {
    expect(() =>
      createServerStaffApiClient({
        apiUpstreamOrigin: "http://localhost:4000",
        cookieName: "syntholo_local_staff_session",
      }),
    ).not.toThrow();
    expect(() =>
      createServerStaffApiClient({
        apiUpstreamOrigin: "http://localhost:4000",
        cookieName: "__Host-syntholo_staff_session",
      }),
    ).toThrow("WEB_SERVER_API_CONFIG_INVALID");
  });

  it.each([
    "https://attacker.test/v1/member/whoami",
    "//attacker.test/v1/staff/whoami",
    "/api/legacy",
  ])("rejects a non-canonical browser API path %s", async (path) => {
    const client = createStaffApiClient({ fetch: vi.fn() });
    await expect(client(path)).rejects.toThrow("WEB_API_PATH_INVALID");
  });

  it("validates explicit production origins and exposes the beforeFiles rewrite", () => {
    expect(
      parseWebApiConfig({
        APP_MODE: "production",
        WEB_ORIGIN: "https://app.syntholo.test",
        API_UPSTREAM_ORIGIN: "https://api.syntholo.internal",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_test",
      }),
    ).toEqual({
      mode: "production",
      webOrigin: "https://app.syntholo.test",
      apiUpstreamOrigin: "https://api.syntholo.internal",
      clerkPublishableKey: "pk_live_test",
      staffCookieName: "__Host-syntholo_staff_session",
      rewrite: {
        source: "/v1/:path*",
        destination: "https://api.syntholo.internal/v1/:path*",
      },
    });
  });

  it.each([
    { APP_MODE: "production" },
    {
      APP_MODE: "production",
      WEB_ORIGIN: "http://app.syntholo.test",
      API_UPSTREAM_ORIGIN: "https://api.syntholo.internal",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_test",
    },
    {
      APP_MODE: "production",
      WEB_ORIGIN: "https://app.syntholo.test/path",
      API_UPSTREAM_ORIGIN: "https://api.syntholo.internal",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_test",
    },
  ])("fails production web configuration closed", (environment) => {
    expect(() => parseWebApiConfig(environment)).toThrow(
      "WEB_API_CONFIG_INVALID",
    );
  });

  it("never falls back to demo configuration in a production Node build", () => {
    expect(() =>
      parseWebApiConfig({ NODE_ENV: "production" }),
    ).toThrow("WEB_API_CONFIG_INVALID");
  });

  it.each([
    "DATABASE_URL",
    "CLERK_SECRET_KEY",
    "WORKOS_API_KEY",
    "STRIPE_SECRET_KEY",
    "HIGHLEVEL_API_KEY",
    "POSTHOG_PERSONAL_API_KEY",
    "OPENAI_API_KEY",
    "NEXT_PUBLIC_OPENAI_API_KEY",
  ])("rejects privileged key %s from the server-side web config", (key) => {
    expect(() => parseWebApiConfig({ APP_MODE: "demo", [key]: "" }))
      .toThrow("WEB_API_CONFIG_INVALID");
  });

  it("rejects preview-to-production upstream linkage", () => {
    expect(() => parseWebApiConfig({
      APP_MODE: "production",
      API_UPSTREAM_ORIGIN: "https://api.syntholo.internal",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_test",
      VERCEL_ENV: "preview",
      WEB_ORIGIN: "https://feature-123.vercel.app",
    })).toThrow("WEB_API_CONFIG_INVALID");
  });

  it("rejects any preview API or authentication linkage even in demo mode", () => {
    expect(() => parseWebApiConfig({
      API_UPSTREAM_ORIGIN: "https://api.syntholo.internal",
      APP_MODE: "demo",
      VERCEL_ENV: "preview",
      WEB_ORIGIN: "https://feature-123.vercel.app",
    })).toThrow("WEB_API_CONFIG_INVALID");
    expect(() => parseWebApiConfig({
      APP_MODE: "demo",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_test",
      VERCEL_ENV: "preview",
    })).toThrow("WEB_API_CONFIG_INVALID");
  });
});
