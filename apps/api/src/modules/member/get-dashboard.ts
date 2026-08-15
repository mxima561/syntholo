import {
  MemberDashboardResponseSchema,
  MemberDashboardV2ResponseSchema,
  type MemberDashboardResponse,
  type MemberDashboardV2Response,
} from "@syntholo/contracts/member-dashboard";
import type { MemberCourseResponse } from "@syntholo/contracts/learning";
import { MemberAccessResponseSchema } from "@syntholo/contracts/entitlements";
import { memberReadParentDeadline } from "@syntholo/database";
import type { EffectiveAccess, MemberActor } from "@syntholo/domain";

type AccountSummary = Readonly<{ id: string; name: string }>;

export type MemberDashboardDependencies = Readonly<{
  accounts: {
    getById(
      scope: Readonly<{ accountId: string }>,
      id: string,
      parentDeadline?: number,
    ): Promise<AccountSummary | null>;
  };
  access: {
    getEffectiveAccess(
      actor: MemberActor,
      parentDeadline?: number,
    ): Promise<unknown>;
  };
  clock: { now(): Date };
}>;

export type MemberDashboardV2Dependencies = MemberDashboardDependencies & Readonly<{
  learning: {
    getDashboardCourse(
      actor: MemberActor,
      correlationId: string,
      parentDeadline?: number,
    ): Promise<MemberCourseResponse | null>;
  };
}>;

export class MemberDashboardActorUnavailableError extends Error {
  constructor() {
    super("MEMBER_DASHBOARD_ACTOR_UNAVAILABLE");
    this.name = "MemberDashboardActorUnavailableError";
  }
}

const foundationProjections = Object.freeze({
  learning: Object.freeze({ state: "unavailable", reason: "module_not_implemented" }),
  support: Object.freeze({ state: "unavailable", reason: "module_not_implemented" }),
  sessions: Object.freeze({ state: "unavailable", reason: "module_not_implemented" }),
  implementation: Object.freeze({ state: "unavailable", reason: "module_not_implemented" }),
  recommendations: Object.freeze({ state: "unavailable", reason: "module_not_implemented" }),
} as const);

export function composeFoundationDashboard(input: Readonly<{
  account: AccountSummary;
  access: EffectiveAccess;
  generatedAt: Date;
}>): MemberDashboardResponse {
  const academyMissing = !input.access.capabilities.academy_course;
  return MemberDashboardResponseSchema.parse({
    schemaVersion: 1,
    generatedAt: input.generatedAt.toISOString(),
    account: { id: input.account.id, name: input.account.name },
    access: input.access,
    experience: { state: academyMissing ? "access_required" : "partial" },
    projections: foundationProjections,
    nextBestStep: academyMissing
      ? {
        kind: "access_blocker",
        reason: "academy_course_required",
        target: "program_options",
      }
      : {
        kind: "unavailable",
        blockedBy: "support",
        reason: "module_not_implemented",
        target: "retry",
      },
  });
}

export async function getMemberDashboard(
  actor: MemberActor,
  dependencies: MemberDashboardDependencies,
): Promise<MemberDashboardResponse> {
  const parentDeadline = memberReadParentDeadline();
  const account = await dependencies.accounts.getById(
    { accountId: actor.accountId },
    actor.accountId,
    parentDeadline,
  );
  if (account === null) throw new MemberDashboardActorUnavailableError();

  const access = MemberAccessResponseSchema.parse(
    await dependencies.access.getEffectiveAccess(actor, parentDeadline),
  );
  const generatedAt = dependencies.clock.now();
  return composeFoundationDashboard({ account, access, generatedAt });
}

function nextLearningStep(course: MemberCourseResponse): MemberDashboardV2Response["nextBestStep"] {
  const lesson = course.stages
    .flatMap((stage) => stage.lessons.map((candidate) => ({
      candidate,
      stageOrder: stage.order,
    })))
    .filter(({ candidate }) =>
      candidate.required
      && candidate.availability === "available"
      && candidate.progress !== "completed")
    .sort((left, right) =>
      left.stageOrder - right.stageOrder
      || left.candidate.order - right.candidate.order
      || left.candidate.id.localeCompare(right.candidate.id))[0]?.candidate ?? null;
  if (lesson !== null) {
    return {
      kind: "lesson",
      reason: "next_required_lesson",
      target: { courseId: course.course.id, lessonId: lesson.id },
    };
  }
  return {
    kind: "course",
    reason: course.progress.completedRequired === course.progress.requiredTotal
      ? "required_lessons_completed"
      : "required_lesson_locked",
    target: { courseId: course.course.id },
  };
}

export async function getMemberDashboardV2(
  actor: MemberActor,
  correlationId: string,
  dependencies: MemberDashboardV2Dependencies,
): Promise<MemberDashboardV2Response> {
  const parentDeadline = memberReadParentDeadline();
  const account = await dependencies.accounts.getById(
    { accountId: actor.accountId },
    actor.accountId,
    parentDeadline,
  );
  if (account === null) throw new MemberDashboardActorUnavailableError();
  const preAccess = MemberAccessResponseSchema.parse(
    await dependencies.access.getEffectiveAccess(actor, parentDeadline),
  );
  if (!preAccess.capabilities.academy_course) {
    return MemberDashboardV2ResponseSchema.parse({
      schemaVersion: 2,
      generatedAt: dependencies.clock.now().toISOString(),
      account: { id: account.id, name: account.name },
      access: preAccess,
      experience: { state: "access_required" },
      learning: { state: "blocked", reason: "course_access_required" },
      nextBestStep: {
        kind: "access_blocker",
        reason: "academy_course_required",
        target: "program_options",
      },
    });
  }
  const course = await dependencies.learning.getDashboardCourse(
    actor,
    correlationId,
    parentDeadline,
  );
  const access = MemberAccessResponseSchema.parse(
    await dependencies.access.getEffectiveAccess(actor, parentDeadline),
  );
  if (!access.capabilities.academy_course) {
    return MemberDashboardV2ResponseSchema.parse({
      schemaVersion: 2,
      generatedAt: dependencies.clock.now().toISOString(),
      account: { id: account.id, name: account.name },
      access,
      experience: { state: "access_required" },
      learning: { state: "blocked", reason: "course_access_required" },
      nextBestStep: {
        kind: "access_blocker",
        reason: "academy_course_required",
        target: "program_options",
      },
    });
  }
  if (course === null) {
    return MemberDashboardV2ResponseSchema.parse({
      schemaVersion: 2,
      generatedAt: dependencies.clock.now().toISOString(),
      account: { id: account.id, name: account.name },
      access,
      experience: { state: "no_enrollment" },
      learning: { state: "empty", reason: "no_enrollment" },
      nextBestStep: {
        kind: "enrollment_blocker",
        reason: "academy_enrollment_missing",
        target: "retry",
      },
    });
  }
  return MemberDashboardV2ResponseSchema.parse({
    schemaVersion: 2,
    generatedAt: dependencies.clock.now().toISOString(),
    account: { id: account.id, name: account.name },
    access,
    experience: { state: "ready" },
    learning: { state: "available", course },
    nextBestStep: nextLearningStep(course),
  });
}
