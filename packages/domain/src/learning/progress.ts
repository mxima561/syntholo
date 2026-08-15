type ReleaseRule =
  | Readonly<{ kind: "immediate" }>
  | Readonly<{ kind: "elapsed_days"; days: number }>
  | Readonly<{ kind: "fixed_at"; at: string }>;

type ResumePosition = Readonly<{ seconds: number }> | Readonly<{ blockId: string }>;
type Resume = Readonly<{
  revision: number;
  lastPath: "video" | "transcript";
  position: ResumePosition;
}>;
type ResumeUpdate = Readonly<{
  expectedVersion: number;
  path: "video" | "transcript";
  position: ResumePosition;
}>;

export function availableAtForReleaseRule(rule: ReleaseRule, enrolledAt: Date): Date {
  if (!Number.isFinite(enrolledAt.getTime())) throw new Error("LEARNING_RELEASE_INPUT_INVALID");
  if (rule.kind === "immediate") return new Date(enrolledAt);
  if (rule.kind === "elapsed_days") {
    if (!Number.isSafeInteger(rule.days) || rule.days < 0 || rule.days > 365) {
      throw new Error("LEARNING_RELEASE_INPUT_INVALID");
    }
    return new Date(enrolledAt.getTime() + rule.days * 86_400_000);
  }
  const at = new Date(rule.at);
  if (!Number.isFinite(at.getTime()) || at.toISOString() !== rule.at) {
    throw new Error("LEARNING_RELEASE_INPUT_INVALID");
  }
  return at;
}

export function courseIsComplete(input: Readonly<{
  requiredLessonIds: readonly string[];
  completedLessonIds: readonly string[];
}>): boolean {
  const required = new Set(input.requiredLessonIds);
  if (required.size !== 18 || required.size !== input.requiredLessonIds.length) return false;
  const completed = new Set(input.completedLessonIds);
  return [...required].every((lessonId) => completed.has(lessonId));
}

export function nextProgressProjection(input: Readonly<{
  completed: boolean;
  current: Resume | null;
  update: ResumeUpdate;
}>): Readonly<{
  revision: number | null;
  state: "in_progress" | "completed";
  lastPath: "video" | "transcript" | null;
  position: ResumePosition | null;
  changed: boolean;
}> {
  if (input.completed && input.current === null) {
    return Object.freeze({
      revision: null,
      state: "completed" as const,
      lastPath: null,
      position: null,
      changed: false,
    });
  }
  if (input.completed && input.current !== null) {
    return Object.freeze({ ...input.current, state: "completed" as const, changed: false });
  }
  const same = input.current !== null
    && input.current.lastPath === input.update.path
    && JSON.stringify(input.current.position) === JSON.stringify(input.update.position);
  if (!same && input.current !== null && input.current.revision !== input.update.expectedVersion) {
    throw new Error("VERSION_CONFLICT");
  }
  if (input.current === null && input.update.expectedVersion !== 0) throw new Error("VERSION_CONFLICT");
  return Object.freeze({
    revision: same ? input.current!.revision : (input.current?.revision ?? 0) + 1,
    state: input.completed ? "completed" : "in_progress",
    lastPath: input.update.path,
    position: Object.freeze({ ...input.update.position }),
    changed: !same,
  });
}
