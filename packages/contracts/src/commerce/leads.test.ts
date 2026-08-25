import { describe, expect, it } from "vitest";
import { AttributionInputSchema } from "./attribution";
import { PilotApplicationInputSchema } from "./applications";
import { ScorecardLeadInputSchema } from "./scorecards";

const validScorecard = {
  firstName: "Maria",
  email: "maria@example.com",
  businessName: "Northstar",
  country: "United States",
  overallScore: 62,
  band: "Building",
  answers: { q1: 2 },
  marketingConsent: false,
};

const validApplication = {
  firstName: "Maria",
  email: "maria@example.com",
  businessName: "Northstar",
  country: "United States",
  goals: "Launch one workflow this quarter.",
  marketingConsent: false,
};

describe("lead capture contracts", () => {
  it("requires an explicit marketing-consent decision on the scorecard", () => {
    const { marketingConsent: _, ...withoutConsent } = validScorecard;
    expect(ScorecardLeadInputSchema.safeParse(withoutConsent).success).toBe(false);
  });

  it.each([
    [{ marketingConsent: undefined }, "marketingConsent"],
    [{ attribution: { firstTouch: { source: "x".repeat(161) } } }, "source"],
    [{ goals: "x".repeat(5_001) }, "goals"],
  ])("rejects invalid application input", (patch, field) => {
    const result = PilotApplicationInputSchema.safeParse({ ...validApplication, ...patch });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.includes(field))).toBe(true);
  });

  it("accepts attribution without ad-platform click ids", () => {
    const parsed = AttributionInputSchema.parse({
      firstTouch: { source: "google", medium: "cpc", campaign: "academy", landingPath: "/scorecard" },
      gclid: "should-strip",
    });
    expect(parsed).toEqual({
      firstTouch: { source: "google", medium: "cpc", campaign: "academy", landingPath: "/scorecard" },
    });
    expect(parsed).not.toHaveProperty("gclid");
  });
});
