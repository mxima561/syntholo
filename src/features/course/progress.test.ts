import { describe, expect, it } from "vitest";
import { getCourseProgressSummary } from "./progress";

describe("getCourseProgressSummary", () => {
  it("separates completed, active, and remaining lessons", () => {
    expect(
      getCourseProgressSummary([
        { status: "completed" },
        { status: "completed" },
        { status: "in_progress" },
        { status: "not_started" },
      ]),
    ).toEqual({ completed: 2, active: 1, remaining: 1, percent: 50 });
  });

  it("returns zero percent for an empty course", () => {
    expect(getCourseProgressSummary([]).percent).toBe(0);
  });
});
