import { describe, expect, it } from "vitest";
import { validateLessonForPublication } from "./validation";

describe("validateLessonForPublication extras", () => {
  it("flags missing title, summary, and duration", () => {
    const issues = validateLessonForPublication({
      id: "x",
      order: 1,
      title: "  ",
      summary: "",
      durationMinutes: 0,
      videoReady: true,
      captionsAssetId: "c",
      transcriptAssetId: "t",
      accessibilityApprovedAt: "2026-08-01T00:00:00.000Z",
      hasAction: true,
      hasResources: true,
      hasDisclosure: true,
      placeholder: false,
    });
    expect(issues.map((issue) => issue.code)).toEqual(["TITLE_REQUIRED", "SUMMARY_REQUIRED", "DURATION_REQUIRED"]);
  });
});
