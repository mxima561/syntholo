import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("CheckoutPage entitlement gate", () => {
  it("sends entitled members to the academy instead of closed checkout", () => {
    const source = readFileSync("src/app/checkout/[offer]/page.tsx", "utf8");
    expect(source).toContain("redirectToAcademyIfEntitled");
    expect(source.indexOf("redirectToAcademyIfEntitled")).toBeLessThan(source.indexOf("resolveCheckoutOffer"));
  });
});
