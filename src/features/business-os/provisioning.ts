import type { SoftwareAccountStatus } from "@/lib/domain/types";

type ProvisioningAction = "start_provisioning" | "activate" | "pause" | "cancel";

export function getProvisioningDueAt(startedAt: Date) {
  const dueAt = new Date(startedAt);
  let daysAdded = 0;
  while (daysAdded < 5) {
    dueAt.setUTCDate(dueAt.getUTCDate() + 1);
    if (dueAt.getUTCDay() !== 0 && dueAt.getUTCDay() !== 6) daysAdded += 1;
  }
  return dueAt;
}

export function transitionProvisioning(input: {
  status: SoftwareAccountStatus;
  questionnairePercent: number;
  action: ProvisioningAction;
  now: Date;
  activationChecks?: boolean[];
}) {
  if (input.action === "start_provisioning") {
    if (input.status !== "pending_onboarding") throw new Error("Only pending accounts can start provisioning.");
    if (input.questionnairePercent < 100) throw new Error("Complete the onboarding questionnaire before provisioning.");
    return { status: "provisioning" as const, provisioningStartedAt: input.now, provisioningDueAt: getProvisioningDueAt(input.now) };
  }
  if (input.action === "activate") {
    if (input.status !== "provisioning") throw new Error("The account must be provisioning before activation.");
    if (!input.activationChecks || input.activationChecks.length < 7 || !input.activationChecks.every(Boolean)) throw new Error("All seven activation checks must pass.");
    return { status: "active" as const };
  }
  if (input.action === "pause") return { status: "paused" as const };
  return { status: "canceled" as const };
}
