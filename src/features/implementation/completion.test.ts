import { describe, expect, it } from "vitest";
import { calculateProgramCompletion } from "./completion";

describe("calculateProgramCompletion", () => {
  it("requires 18 lessons, five final artifacts, and three live workflows", () => {
    expect(calculateProgramCompletion({ completedLessons: 18, finalArtifacts: 5, liveWorkflows: 3 })).toMatchObject({
      complete: true,
      percent: 100,
    });
  });

  it("does not award completion for lessons alone", () => {
    const result = calculateProgramCompletion({ completedLessons: 18, finalArtifacts: 0, liveWorkflows: 0 });
    expect(result.complete).toBe(false);
    expect(result.requirements.artifacts.complete).toBe(false);
    expect(result.requirements.workflows.complete).toBe(false);
  });

  it("caps progress at 100 percent", () => {
    expect(calculateProgramCompletion({ completedLessons: 30, finalArtifacts: 8, liveWorkflows: 6 }).percent).toBe(100);
  });
});
