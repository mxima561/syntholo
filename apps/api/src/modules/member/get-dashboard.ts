import {
  MemberDashboardResponseSchema,
  MemberDashboardV2ResponseSchema,
  MemberDashboardV3ResponseSchema,
  type MemberDashboardResponse,
  type MemberDashboardV2Response,
  type MemberDashboardV3Response,
} from "@syntholo/contracts/member-dashboard";
import type { ArtifactListResponse } from "@syntholo/contracts/implementation";
import type { MemberCourseResponse } from "@syntholo/contracts/learning";
import { MemberAccessResponseSchema } from "@syntholo/contracts/entitlements";
import {
  ImplementationRepositoryError,
  memberReadParentDeadline,
} from "@syntholo/database";
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

export type MemberDashboardV3Dependencies = MemberDashboardV2Dependencies & Readonly<{
  implementation: {
    list(
      actor: MemberActor,
      correlationId: string,
      parentDeadline?: number,
    ): Promise<ArtifactListResponse>;
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

type MemberDashboardV2Projection = Omit<
  MemberDashboardV2Response,
  "schemaVersion" | "generatedAt"
>;

function blockedProjection(
  account: AccountSummary,
  access: EffectiveAccess,
): MemberDashboardV2Projection {
  return {
    account: { id: account.id, name: account.name },
    access: MemberAccessResponseSchema.parse(access),
    experience: { state: "access_required" },
    learning: { state: "blocked", reason: "course_access_required" },
    nextBestStep: {
      kind: "access_blocker",
      reason: "academy_course_required",
      target: "program_options",
    },
  };
}

async function resolveMemberDashboardV2(
  actor: MemberActor,
  correlationId: string,
  dependencies: MemberDashboardV2Dependencies,
  parentDeadline: number,
): Promise<MemberDashboardV2Projection> {
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
    return blockedProjection(account, preAccess);
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
    return blockedProjection(account, access);
  }
  if (course === null) {
    return {
      account: { id: account.id, name: account.name },
      access,
      experience: { state: "no_enrollment" },
      learning: { state: "empty", reason: "no_enrollment" },
      nextBestStep: {
        kind: "enrollment_blocker",
        reason: "academy_enrollment_missing",
        target: "retry",
      },
    };
  }
  return {
    account: { id: account.id, name: account.name },
    access,
    experience: { state: "ready" },
    learning: { state: "available", course },
    nextBestStep: nextLearningStep(course),
  };
}

export async function getMemberDashboardV2(
  actor: MemberActor,
  correlationId: string,
  dependencies: MemberDashboardV2Dependencies,
): Promise<MemberDashboardV2Response> {
  const projection = await resolveMemberDashboardV2(
    actor,
    correlationId,
    dependencies,
    memberReadParentDeadline(),
  );
  return MemberDashboardV2ResponseSchema.parse({
    schemaVersion: 2,
    generatedAt: dependencies.clock.now().toISOString(),
    ...projection,
  });
}

export async function getMemberDashboardV3(
  actor: MemberActor,
  correlationId: string,
  dependencies: MemberDashboardV3Dependencies,
): Promise<MemberDashboardV3Response> {
  const parentDeadline = memberReadParentDeadline();
  let projection = await resolveMemberDashboardV2(
    actor,
    correlationId,
    dependencies,
    parentDeadline,
  );
  let artifacts: ArtifactListResponse | null = null;
  if (projection.experience.state === "ready") {
    try {
      artifacts = await dependencies.implementation.list(
        actor,
        correlationId,
        parentDeadline,
      );
    } catch (error) {
      if (!(error instanceof ImplementationRepositoryError)
        || error.code !== "IMPLEMENTATION_NOT_FOUND") throw error;
      const access = MemberAccessResponseSchema.parse(
        await dependencies.access.getEffectiveAccess(actor, parentDeadline),
      );
      if (access.capabilities.academy_course) throw error;
      projection = blockedProjection(projection.account, access);
    }
    if (artifacts !== null) {
      const access = MemberAccessResponseSchema.parse(
        await dependencies.access.getEffectiveAccess(actor, parentDeadline),
      );
      if (!access.capabilities.academy_course) {
        artifacts = null;
        projection = blockedProjection(projection.account, access);
      } else {
        projection = { ...projection, access };
      }
    }
  }
  const implementation = projection.experience.state === "access_required"
    ? { state: "blocked" as const, reason: "course_access_required" as const }
    : projection.experience.state === "no_enrollment"
      ? { state: "empty" as const, reason: "no_enrollment" as const }
      : {
          state: "available" as const,
          artifacts: artifacts!,
        };
  return MemberDashboardV3ResponseSchema.parse({
    schemaVersion: 3,
    generatedAt: dependencies.clock.now().toISOString(),
    ...projection,
    implementation,
  });
}
