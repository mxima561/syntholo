const targets = { lessons: 18, artifacts: 5, workflows: 3 } as const;

export function calculateProgramCompletion(input: {
  completedLessons: number;
  finalArtifacts: number;
  liveWorkflows: number;
}) {
  const lessonsRatio = Math.min(input.completedLessons / targets.lessons, 1);
  const artifactsRatio = Math.min(input.finalArtifacts / targets.artifacts, 1);
  const workflowsRatio = Math.min(input.liveWorkflows / targets.workflows, 1);
  const requirements = {
    lessons: { current: input.completedLessons, target: targets.lessons, complete: input.completedLessons >= targets.lessons },
    artifacts: { current: input.finalArtifacts, target: targets.artifacts, complete: input.finalArtifacts >= targets.artifacts },
    workflows: { current: input.liveWorkflows, target: targets.workflows, complete: input.liveWorkflows >= targets.workflows },
  };

  return {
    complete: Object.values(requirements).every((requirement) => requirement.complete),
    percent: Math.min(100, Math.round(lessonsRatio * 50 + artifactsRatio * 30 + workflowsRatio * 20)),
    requirements,
  };
}
