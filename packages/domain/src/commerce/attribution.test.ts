import { describe, expect, it } from "vitest";
import { normalizeAttribution } from "./attribution";

describe("normalizeAttribution", () => {
  it("clips campaign fields to 160 characters", () => {
    const normalized = normalizeAttribution({
      firstTouch: { source: `${"paid".repeat(80)}-source`, campaign: "  spring  " },
    });
    expect(normalized.firstTouch?.source?.length).toBe(160);
    expect(normalized.firstTouch?.campaign).toBe("spring");
  });
});
