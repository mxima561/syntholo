import { describe, expect, it } from "vitest";
import { CreateCheckoutInputSchema, PublicOfferSchema } from "./offers";

describe("commerce offer contracts", () => {
  it("rejects a browser-supplied price on checkout input", () => {
    const parsed = CreateCheckoutInputSchema.parse({
      offerCode: "self_paced",
      email: "owner@example.com",
      amount: 1,
      priceId: "price_from_browser",
      canSellAcademy: true,
    });
    expect(parsed).toEqual({ offerCode: "self_paced", email: "owner@example.com" });
    expect(parsed).not.toHaveProperty("priceId");
    expect(parsed).not.toHaveProperty("amount");
    expect(parsed).not.toHaveProperty("canSellAcademy");
  });

  it("omits provider identifiers from the public offer shape", () => {
    const offer = PublicOfferSchema.parse({
      code: "self_paced",
      slug: "self-paced",
      name: "AI Operating System Academy",
      kind: "payment",
      state: "enabled",
      displayAmount: "$399.00",
      available: false,
      reasonCode: "CURRICULUM_GATE_BLOCKED",
      startsAt: null,
    });
    expect(JSON.stringify(offer)).not.toMatch(/price_/);
    expect(offer).not.toHaveProperty("stripePriceId");
  });
});
