import {
  MemberDashboardResponseSchema,
  type MemberDashboardResponse,
} from "@syntholo/contracts/member-dashboard";
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
