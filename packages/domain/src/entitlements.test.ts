import { describe, expect, it } from "vitest";
import {
  assertHoldClear,
  canAccess,
  evaluateEntitlements,
  GRANT_CAPABILITIES,
  grantCapabilityToKind,
  hasCapability,
  holdsForOpenDispute,
  reservedSeatsFromCount,
  type EntitlementGrant,
  type GrantStatus,
} from "./entitlements";
import type { Entitlement } from "./types";

const now = new Date("2026-08-11T12:00:00.000Z");
const day0 = new Date("2025-08-11T12:00:00.000Z");
const day366 = new Date("2026-08-12T12:00:00.000Z");

function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    id: "ent-1",
    organizationId: "org-1",
    kind: "course",
    status: "active",
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: null,
    ...overrides,
  };
}

function grant(overrides: Partial<EntitlementGrant> = {}): EntitlementGrant {
  return {
    id: "g1",
    capability: "academy_course",
    status: "active",
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: null,
    ...overrides,
  };
}

function evaluate(overrides: Partial<Parameters<typeof evaluateEntitlements>[0]> = {}) {
  return evaluateEntitlements({
    accountId: "acct-1",
    now,
    grants: [],
    holds: [],
    seats: [],
    ...overrides,
  });
}

describe("canAccess", () => {
  it("allows an active lifetime course entitlement", () => {
    expect(canAccess("course", [entitlement()], now)).toBe(true);
  });

  it("blocks expired community write access", () => {
    expect(
      canAccess(
        "community_write",
        [
          entitlement({
            kind: "community_write",
            status: "active",
            endsAt: "2026-08-01T00:00:00.000Z",
          }),
        ],
        now,
      ),
    ).toBe(false);
  });

  it("keeps subscription access during grace", () => {
    expect(
      canAccess(
        "operator_club",
        [entitlement({ kind: "operator_club", status: "grace" })],
        now,
      ),
    ).toBe(true);
  });

  it("does not allow refunded or revoked access", () => {
    expect(canAccess("course", [entitlement({ status: "refunded" })], now)).toBe(false);
    expect(canAccess("course", [entitlement({ status: "revoked" })], now)).toBe(false);
  });
});

describe("hasCapability", () => {
  it("maps academy_course onto the course entitlement kind", () => {
    expect(grantCapabilityToKind("academy_course")).toBe("course");
    expect(
      hasCapability(
        "academy_course",
        [
          {
            id: "g1",
            capability: "academy_course",
            status: "active",
            startsAt: "2026-01-01T00:00:00.000Z",
            endsAt: null,
          },
        ],
        now,
      ),
    ).toBe(true);
  });

  it("does not treat a Business OS grant as academy access", () => {
    expect(
      hasCapability(
        "academy_course",
        [
          {
            id: "g2",
            capability: "business_os",
            status: "active",
            startsAt: "2026-01-01T00:00:00.000Z",
            endsAt: null,
          },
        ],
        now,
      ),
    ).toBe(false);
  });
});

describe("evaluateEntitlements", () => {
  it("keeps lifetime course access after support expiry", () => {
    const result = evaluate({
      now: day366,
      grants: [
        grant({ id: "course", capability: "academy_course", startsAt: day0, endsAt: null }),
        grant({
          id: "support",
          capability: "support",
          startsAt: day0,
          endsAt: new Date("2026-08-11T12:00:00.000Z"),
        }),
        grant({
          id: "circle",
          capability: "circle_write",
          startsAt: day0,
          endsAt: new Date("2026-08-11T12:00:00.000Z"),
        }),
      ],
    });
    expect(result.capabilities.academy_course).toBe(true);
    expect(result.capabilities.support).toBe(false);
    expect(result.capabilities.circle_write).toBe(false);
  });

  it("never lets Business OS state gate Academy", () => {
    const result = evaluate({
      grants: [
        grant({ id: "course", capability: "academy_course" }),
        grant({ id: "os", capability: "business_os", status: "revoked" }),
      ],
    });
    expect(result.capabilities.academy_course).toBe(true);
    expect(result.capabilities.business_os).toBe(false);
  });

  it.each(["active", "grace"] as const)("allows academy access while %s", (status) => {
    expect(evaluate({ grants: [grant({ status })] }).capabilities.academy_course).toBe(true);
  });

  it.each(["expired", "refunded", "revoked"] as const)("blocks academy access when %s", (status) => {
    expect(evaluate({ grants: [grant({ status })] }).capabilities.academy_course).toBe(false);
  });

  it("ignores grants that have not started yet", () => {
    const result = evaluate({
      grants: [
        grant({
          id: "club",
          capability: "operator_club",
          startsAt: "2026-09-01T00:00:00.000Z",
        }),
      ],
    });
    expect(result.capabilities.operator_club).toBe(false);
  });

  it("unions overlapping grants and sorts source ids", () => {
    const result = evaluate({
      grants: [
        grant({ id: "g-b", capability: "academy_course" }),
        grant({ id: "g-a", capability: "academy_course", status: "grace" }),
        grant({ id: "g-dead", capability: "academy_course", status: "refunded" }),
      ],
    });
    expect(result.capabilities.academy_course).toBe(true);
    expect(result.explanations.find((row) => row.capability === "academy_course")?.sourceGrantIds).toEqual([
      "g-a",
      "g-b",
    ]);
  });

  it("does not expose a certificate capability", () => {
    const result = evaluate({ grants: [grant()] });
    expect(Object.keys(result.capabilities).sort()).toEqual([...GRANT_CAPABILITIES].sort());
    expect("certificate" in result.capabilities).toBe(false);
  });

  it("counts only reserved seats against the three-seat limit", () => {
    const result = evaluate({
      seats: [
        ...reservedSeatsFromCount(2),
        { status: "expired" },
        { status: "released" },
      ],
    });
    expect(result.seatLimit).toBe(3);
    expect(result.reservedSeats).toBe(2);
  });

  it("records dispute holds without turning off academy_course", () => {
    const result = evaluate({
      grants: [grant()],
      holds: holdsForOpenDispute().map((kind) => ({ kind, active: true })),
    });
    expect(result.capabilities.academy_course).toBe(true);
    expect(result.holds).toEqual(["commerce", "seat_changes", "business_os_activation"]);
    expect(() => assertHoldClear(result, "commerce")).toThrow(/commerce/i);
    expect(() => assertHoldClear(result, "seat_changes")).toThrow(/seat changes/i);
  });

  it("ignores inactive holds", () => {
    const result = evaluate({
      grants: [grant()],
      holds: [{ kind: "commerce", active: false }],
    });
    expect(result.holds).toEqual([]);
  });

  it("never derives Academy from Business OS grants", () => {
    const statuses: GrantStatus[] = ["active", "grace", "expired", "refunded", "revoked"];
    const windows = [null, "2027-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"] as const;
    for (const status of statuses) {
      for (const endsAt of windows) {
        const access = evaluate({
          grants: [grant({ id: `bos-${status}-${endsAt ?? "open"}`, capability: "business_os", status, endsAt })],
        });
        expect(access.capabilities.academy_course).toBe(false);
      }
    }
  });
});
