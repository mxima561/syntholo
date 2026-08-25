import { describe, expect, it, vi } from "vitest";
import { CheckoutAuthorizationError } from "@syntholo/domain";
import { createCheckout } from "./create-checkout";

const command = {
  offerCode: "self_paced",
  email: "owner@example.com",
  idempotencyKey: "idem-1",
  successUrl: "https://example.com/claim?session_id={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://example.com/pricing",
};

describe("createCheckout", () => {
  it("does not call Stripe while the curriculum gate is closed", async () => {
    const stripe = { createCheckoutSession: vi.fn() };
    await expect(createCheckout(command, { stripe, env: { NODE_ENV: "production" } })).rejects.toMatchObject({
      code: "CURRICULUM_GATE_BLOCKED",
    });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied canSellAcademy flag", async () => {
    const stripe = { createCheckoutSession: vi.fn() };
    await expect(
      createCheckout(
        { ...command, canSellAcademy: true, priceId: "price_from_browser", amount: 1 },
        { stripe, env: { NODE_ENV: "production" } },
      ),
    ).rejects.toBeInstanceOf(CheckoutAuthorizationError);
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("does not honor a staging override in production", async () => {
    const stripe = { createCheckoutSession: vi.fn() };
    await expect(
      createCheckout(command, {
        stripe,
        env: { NODE_ENV: "production", ACADEMY_CHECKOUT_STAGING_OVERRIDE: "1" },
      }),
    ).rejects.toMatchObject({ code: "CURRICULUM_GATE_BLOCKED" });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });
});
