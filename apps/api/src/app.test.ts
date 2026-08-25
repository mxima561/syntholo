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

  it("lists public offers without Stripe identifiers and keeps Academy closed", async () => {
    const app = buildApi();
    const response = await app.inject({ method: "GET", url: "/v1/public/offers" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { offers: Array<{ code: string; available: boolean; reasonCode: string | null }> };
    const payload = JSON.stringify(body);
    expect(payload).not.toMatch(/price_/);
    expect(payload).not.toContain("stripePriceId");
    const selfPaced = body.offers.find((offer) => offer.code === "self_paced");
    const guided = body.offers.find((offer) => offer.code === "guided_pilot");
    const scorecard = body.offers.find((offer) => offer.code === "scorecard");
    expect(selfPaced).toMatchObject({ available: false, reasonCode: "CURRICULUM_GATE_BLOCKED" });
    expect(guided).toMatchObject({ available: false, reasonCode: "CURRICULUM_GATE_BLOCKED" });
    expect(scorecard?.available).toBe(true);
    await app.close();
  });

  it("rejects Academy checkout while the curriculum gate is closed", async () => {
    const app = buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/v1/public/checkout",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        offerCode: "self_paced",
        email: "owner@example.com",
        canSellAcademy: true,
        priceId: "price_from_browser",
      }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CURRICULUM_GATE_BLOCKED");
    expect(response.json().error.message).toBe("Enrollment is not open yet.");
    await app.close();
  });

  it("does not honor a staging override in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ACADEMY_CHECKOUT_STAGING_OVERRIDE", "1");
    const app = buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/v1/public/checkout",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ offerCode: "self_paced", email: "owner@example.com" }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CURRICULUM_GATE_BLOCKED");
    await app.close();
  });
});
