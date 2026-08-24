import { describe, expect, it } from "vitest";
import { hasCapability } from "@syntholo/domain";
import { supportWindowEnd, type EntitlementGrantRecord } from "./entitlements";

function grant(overrides: Partial<EntitlementGrantRecord> = {}): EntitlementGrantRecord {
  return {
    id: "g1",
    accountId: "a1",
    userId: "u1",
    capability: "academy_course",
    status: "active",
    source: "purchase",
    sourceId: "p1",
    startsAt: new Date("2026-01-01T00:00:00.000Z"),
    endsAt: null,
    ...overrides,
  };
}

describe("entitlement grant evaluation", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");

  it("allows academy access from an active course grant", () => {
    expect(hasCapability("academy_course", [grant()], now)).toBe(true);
  });

  it("does not allow academy access from a refunded purchase grant", () => {
    expect(hasCapability("academy_course", [grant({ status: "refunded" })], now)).toBe(false);
  });

  it("does not treat Business OS as academy access", () => {
    expect(hasCapability("academy_course", [grant({ capability: "business_os" })], now)).toBe(false);
  });

  it("sets support windows one UTC year out", () => {
    expect(supportWindowEnd(new Date("2026-08-24T00:00:00.000Z")).toISOString()).toBe("2027-08-24T00:00:00.000Z");
  });
});
