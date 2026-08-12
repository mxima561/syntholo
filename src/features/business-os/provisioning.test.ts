import { describe, expect, it } from "vitest";
import { getProvisioningDueAt, transitionProvisioning } from "./provisioning";

describe("Business OS provisioning", () => {
  it("sets the due date five business days after a complete questionnaire", () => {
    expect(getProvisioningDueAt(new Date("2026-08-14T15:00:00.000Z")).toISOString()).toBe("2026-08-21T15:00:00.000Z");
  });

  it("will not provision an incomplete questionnaire", () => {
    expect(() => transitionProvisioning({
      status: "pending_onboarding",
      questionnairePercent: 80,
      action: "start_provisioning",
      now: new Date("2026-08-14T15:00:00.000Z"),
    })).toThrow(/questionnaire/i);
  });

  it("activates only after every launch check passes", () => {
    expect(transitionProvisioning({
      status: "provisioning",
      questionnairePercent: 100,
      action: "activate",
      now: new Date("2026-08-18T15:00:00.000Z"),
      activationChecks: [true, true, true, true, true, true, true],
    }).status).toBe("active");
  });
});
