import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PricingPage entitlement gate", () => {
  it("sends entitled members to the academy instead of asking them to buy", () => {
    const source = readFileSync("src/app/pricing/page.tsx", "utf8");
    expect(source).toContain("redirectToAcademyIfEntitled");
    expect(source.indexOf("redirectToAcademyIfEntitled")).toBeLessThan(source.indexOf("pricing-hero"));
  });
});
