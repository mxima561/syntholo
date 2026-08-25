import { describe, expect, it } from "vitest";
import { evaluateLaunchReadiness } from "./evaluate-launch-readiness";

describe("evaluateLaunchReadiness", () => {
  it("reports the current academy as not sellable", () => {
    const { report, readiness } = evaluateLaunchReadiness(new Date("2026-08-25T00:00:00.000Z"));
    expect(readiness.requiredLessons).toBe(18);
    expect(readiness.canSellAcademy).toBe(false);
    expect(readiness.humanApprovedAt).toBeNull();
    expect(report.issues.length).toBeGreaterThan(0);
  });
});
