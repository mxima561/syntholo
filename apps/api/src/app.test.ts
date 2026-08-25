import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "./app";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("api health", () => {
  it("returns the shared release SHA payload", async () => {
    vi.stubEnv("RELEASE_SHA", "gate1");
    const app = buildApi();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "api", releaseSha: "gate1" });
    await app.close();
  });

  it("returns 503 when Stripe is not configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const app = buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("does not accept an accountId query on member access", async () => {
    const app = buildApi();
    const withQuery = await app.inject({ method: "GET", url: "/v1/member/access?accountId=acct-1" });
    expect(withQuery.statusCode).toBe(400);
    const unauthenticated = await app.inject({ method: "GET", url: "/v1/member/access" });
    expect(unauthenticated.statusCode).toBe(401);
    await app.close();
  });
});
