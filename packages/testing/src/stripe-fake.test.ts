import { describe, expect, it } from "vitest";
import { createDeterministicStripeFixture } from "./stripe-fake.js";

describe("deterministic Stripe test composition", () => {
  it("records calls and returns reusable canonical objects without provider I/O", async () => {
    const fixture = createDeterministicStripeFixture({ nodeEnv: "test" });
    await expect(fixture.client.checkoutSessionsCreate({ mode: "payment" }, {
      idempotencyKey: "checkout:test-action",
    })).resolves.toMatchObject({ id: "cs_syntholo_fixture", object: "checkout.session" });
    await expect(fixture.client.setupIntentsRetrieve("seti_syntholo_fixture", {
      expand: ["payment_method"],
    })).resolves.toMatchObject({
      id: "seti_syntholo_fixture",
      status: "succeeded",
      customer: "cus_syntholo_fixture",
      payment_method: {
        id: "pm_syntholo_fixture",
        customer: "cus_syntholo_fixture",
      },
    });
    expect(fixture.calls).toEqual([
      { operation: "checkout.sessions.create", args: [{ mode: "payment" }, { idempotencyKey: "checkout:test-action" }] },
      { operation: "setup_intents.retrieve", args: ["seti_syntholo_fixture", { expand: ["payment_method"] }] },
    ]);
    const rawBody = Buffer.from("fixture-event");
    expect(fixture.signWebhook(rawBody, 1_776_441_600, "current")).toMatch(
      /^t=1776441600,v1=[0-9a-f]{64}$/u,
    );
  });

  it("is unreachable from production composition", () => {
    expect(() => createDeterministicStripeFixture({ nodeEnv: "production" }))
      .toThrowError(new Error("STRIPE_TEST_FIXTURE_FORBIDDEN"));
  });
});
