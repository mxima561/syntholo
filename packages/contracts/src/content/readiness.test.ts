import { describe, expect, it } from "vitest";
import { ContentLaunchReadinessSchema } from "./readiness";

const ready = {
  requiredLessons: 18 as const,
  readyLessons: 18,
  contentHash: "abc123",
  automatedPassedAt: "2026-08-01T00:00:00.000Z",
  humanApprovedAt: "2026-08-02T00:00:00.000Z",
  canSellAcademy: true,
};

describe("ContentLaunchReadinessSchema", () => {
  it("accepts a complete launch report", () => {
    expect(ContentLaunchReadinessSchema.parse(ready)).toEqual(ready);
  });

  it("rejects a client flag that claims the academy is for sale without both gates", () => {
    const result = ContentLaunchReadinessSchema.safeParse({
      ...ready,
      automatedPassedAt: "2026-08-01T00:00:00.000Z",
      humanApprovedAt: null,
      canSellAcademy: true,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a blocked report", () => {
    expect(
      ContentLaunchReadinessSchema.parse({
        requiredLessons: 18,
        readyLessons: 0,
        contentHash: "empty",
        automatedPassedAt: null,
        humanApprovedAt: null,
        canSellAcademy: false,
      }).canSellAcademy,
    ).toBe(false);
  });
});
