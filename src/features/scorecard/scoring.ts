import { scorecardQuestions, type ScoreDimension } from "./questions";

export type ReadinessBand = "Foundation" | "Exploring" | "Building" | "Scaling";

export type ScorecardResult = {
  overall: number;
  band: ReadinessBand;
  dimensionScores: Record<ScoreDimension, number>;
  strongestDimension: ScoreDimension;
  priorityDimensions: ScoreDimension[];
  recommendedWorkflow: string;
};

const dimensions: ScoreDimension[] = ["strategy", "safety", "growth", "client", "operations"];

const workflowByDimension: Record<ScoreDimension, string> = {
  strategy: "AI opportunity and ownership map",
  safety: "Team AI policy and data rules",
  growth: "Lead response and follow-up",
  client: "Client onboarding and communication",
  operations: "Weekly owner brief and follow-through",
};

export function classifyBand(score: number): ReadinessBand {
  if (score >= 75) return "Scaling";
  if (score >= 50) return "Building";
  if (score >= 25) return "Exploring";
  return "Foundation";
}

export function calculateScore(answers: Record<string, number>): ScorecardResult {
  const dimensionScores = Object.fromEntries(
    dimensions.map((dimension) => {
      const questions = scorecardQuestions.filter((question) => question.dimension === dimension);
      const earned = questions.reduce((sum, question) => sum + (answers[question.id] ?? 0), 0);
      return [dimension, Math.round((earned / (questions.length * 4)) * 100)];
    }),
  ) as Record<ScoreDimension, number>;

  const overall = Math.round(
    Object.values(dimensionScores).reduce((sum, score) => sum + score, 0) / dimensions.length,
  );
  const ranked = [...dimensions].sort((a, b) => dimensionScores[a] - dimensionScores[b]);

  return {
    overall,
    band: classifyBand(overall),
    dimensionScores,
    strongestDimension: ranked.at(-1) ?? "strategy",
    priorityDimensions: ranked.slice(0, 2),
    recommendedWorkflow: workflowByDimension[ranked[0] ?? "strategy"],
  };
}

export const dimensionLabels: Record<ScoreDimension, string> = {
  strategy: "Strategy & leadership",
  safety: "Safety & governance",
  growth: "Growth & sales",
  client: "Client delivery",
  operations: "Operations & adoption",
};

