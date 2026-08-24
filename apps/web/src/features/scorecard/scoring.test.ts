import { describe, expect, it } from "vitest";
import { calculateScore, classifyBand } from "./scoring";
import { scorecardQuestions } from "./questions";

function answerEveryQuestion(value: number) {
  return Object.fromEntries(scorecardQuestions.map((question) => [question.id, value]));
}

describe("calculateScore", () => {
  it("classifies an all-zero assessment as Foundation", () => {
    const result = calculateScore(answerEveryQuestion(0));

    expect(result.overall).toBe(0);
    expect(result.band).toBe("Foundation");
    expect(result.dimensionScores).toEqual({
      strategy: 0,
      safety: 0,
      growth: 0,
      client: 0,
      operations: 0,
    });
  });

  it("classifies a maximum assessment as Scaling", () => {
    const result = calculateScore(answerEveryQuestion(4));

    expect(result.overall).toBe(100);
    expect(result.band).toBe("Scaling");
  });

  it.each([
    [24, "Foundation"],
    [25, "Exploring"],
    [49, "Exploring"],
    [50, "Building"],
    [74, "Building"],
    [75, "Scaling"],
  ] as const)("uses the approved boundary %s for %s", (overall, band) => {
    expect(classifyBand(overall)).toBe(band);
  });

  it("recommends the lowest-scoring business dimension", () => {
    const answers = answerEveryQuestion(4);
    for (const question of scorecardQuestions.filter((item) => item.dimension === "growth")) {
      answers[question.id] = 0;
    }

    expect(calculateScore(answers).recommendedWorkflow).toBe("Lead response and follow-up");
  });
});
