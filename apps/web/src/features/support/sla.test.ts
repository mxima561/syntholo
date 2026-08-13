import { describe, expect, it } from "vitest";
import { addBusinessHours, getSlaState } from "./sla";

describe("support SLA", () => {
  it("skips weekends when adding two business days", () => {
    const fridayMorning = new Date("2026-08-14T10:00:00.000Z");
    expect(addBusinessHours(fridayMorning, 16).toISOString()).toBe("2026-08-18T10:00:00.000Z");
  });

  it("warns operations in the final eight business hours", () => {
    expect(getSlaState({
      now: new Date("2026-08-12T14:00:00.000Z"),
      dueAt: new Date("2026-08-12T20:00:00.000Z"),
      status: "waiting_on_coach",
    })).toBe("warning");
  });

  it("pauses while the customer owes the next response", () => {
    expect(getSlaState({
      now: new Date("2026-08-12T14:00:00.000Z"),
      dueAt: new Date("2026-08-12T20:00:00.000Z"),
      status: "waiting_on_customer",
    })).toBe("paused");
  });
});
