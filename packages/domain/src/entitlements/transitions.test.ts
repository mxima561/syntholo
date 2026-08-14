import { describe, expect, it } from "vitest";
import {
  GRANT_STATUSES,
  addExactly168Hours,
  oneYearAnniversaryUtc,
  type EntitlementGrant,
  type GrantStatus,
} from "./index.js";
import { transitionGrant, type GrantTransitionReason } from "./internal.js";

const reasons = ["payment_failure", "recovery", "terminal"] as const;
const allowed = new Set([
  "active:grace:payment_failure",
  "active:expired:terminal",
  "active:refunded:terminal",
  "active:revoked:terminal",
  "grace:active:recovery",
  "grace:expired:terminal",
  "grace:refunded:terminal",
  "grace:revoked:terminal",
  "expired:refunded:terminal",
  "expired:revoked:terminal",
]);
const baseGrant: EntitlementGrant = {
  id: "10000000-0000-4000-8000-000000000001",
  accountId: "10000000-0000-4000-8000-000000000002",
  capability: "operator_club",
  status: "active",
  sourceKind: "subscription",
  sourceId: "club-source",
  offerCode: "operator_club_monthly",
  academySourceId: "academy-source",
  sourceCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
  startsAt: new Date("2026-01-01T00:00:00.000Z"),
  endsAt: new Date("2026-02-01T00:00:00.000Z"),
};

describe("grant transitions", () => {
  it.each(GRANT_STATUSES.flatMap((from) =>
    GRANT_STATUSES.flatMap((to) => reasons.map((reason) =>
      [from, to, reason] as const,
    )),
  ))("enforces the exact matrix for %s -> %s via %s", (from, to, reason) => {
    const key = `${from}:${to}:${reason}`;
    const grant = { ...baseGrant, status: from };
    if (allowed.has(key)) {
      expect(transitionGrant(grant, to, reason).status).toBe(to);
    } else {
      expect(() => transitionGrant(grant, to, reason))
        .toThrow("GRANT_TRANSITION_INVALID");
    }
  });

  it.each([
    ["Academy purchase", { ...baseGrant, capability: "academy_course" as const,
      sourceKind: "purchase" as const, offerCode: "self_paced" as const,
      academySourceId: null, endsAt: null }],
    ["administrative", { ...baseGrant, capability: "support" as const,
      sourceKind: "administrative" as const, offerCode: null,
      academySourceId: null }],
  ])("rejects payment grace for %s grants", (_label, grant) => {
    expect(() => transitionGrant(grant, "grace", "payment_failure"))
      .toThrow("GRANT_TRANSITION_INVALID");
  });

  it("contains every status and reason combination exactly once", () => {
    const cases: readonly (readonly [
      GrantStatus,
      GrantStatus,
      GrantTransitionReason,
    ])[] =
      GRANT_STATUSES.flatMap((from) => GRANT_STATUSES.flatMap((to) =>
        reasons.map((reason) => [from, to, reason] as const),
      ));
    expect(cases).toHaveLength(75);
    expect(new Set(cases.map((entry) => entry.join(":"))).size).toBe(75);
  });
});

describe("commercial time boundaries", () => {
  it("adds exactly 168 hours across a daylight-saving boundary", () => {
    const start = new Date("2026-03-07T12:30:00.123Z");
    expect(addExactly168Hours(start).toISOString())
      .toBe("2026-03-14T12:30:00.123Z");
  });

  it("clamps a leap-day anniversary to the target month last day", () => {
    expect(oneYearAnniversaryUtc(new Date("2024-02-29T23:59:59.999Z")).toISOString())
      .toBe("2025-02-28T23:59:59.999Z");
  });

  it("preserves UTC millisecond precision", () => {
    expect(oneYearAnniversaryUtc(new Date("2026-08-13T12:00:00.321Z")).toISOString())
      .toBe("2027-08-13T12:00:00.321Z");
  });

  it("uses the explicit modern commercial range instead of JavaScript year coercion", () => {
    expect(() => oneYearAnniversaryUtc(new Date("0098-08-13T12:00:00.123Z")))
      .toThrow("COMMERCIAL_TIME_INVALID");
    expect(oneYearAnniversaryUtc(new Date("2000-01-01T00:00:00.000Z")).toISOString())
      .toBe("2001-01-01T00:00:00.000Z");
    expect(() => oneYearAnniversaryUtc(new Date("9999-12-31T23:59:59.999Z")))
      .toThrow("COMMERCIAL_TIME_INVALID");
  });

  it.each([new Date(Number.NaN), new Date(8.64e15 + 1)])(
    "rejects an invalid instant",
    (value) => {
      expect(() => addExactly168Hours(value)).toThrow("COMMERCIAL_TIME_INVALID");
      expect(() => oneYearAnniversaryUtc(value)).toThrow("COMMERCIAL_TIME_INVALID");
    },
  );
});
