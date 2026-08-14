import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  evaluateEntitlements,
  type AccountHold,
  type EntitlementEvaluationInput,
  type EntitlementGrant,
  type SeatReservation,
} from "./index.js";

const accountId = "10000000-0000-4000-8000-000000000001";
const otherAccountId = "20000000-0000-4000-8000-000000000002";
const now = new Date("2026-08-13T12:00:00.000Z");

function input(
  grants: readonly EntitlementGrant[],
  holds: readonly AccountHold[] = [],
  seats: readonly SeatReservation[] = [],
): EntitlementEvaluationInput {
  return { accountId, now, grants, holds, seats };
}

function offset(milliseconds: number): Date {
  return new Date(now.getTime() + milliseconds);
}

const administrativeCapabilityArbitrary = fc.constantFrom(
  "academy_course" as const,
  "support" as const,
  "circle_write" as const,
  "operator_club" as const,
);
const statusAndEndArbitrary = fc.oneof(
  fc.record({
    status: fc.constant("active" as const),
    startsAt: fc.constant(offset(-86_400_000)),
    endsAt: fc.constantFrom(null, offset(86_400_000)),
  }),
  fc.record({
    status: fc.constant("active" as const),
    startsAt: fc.constant(offset(86_400_000)),
    endsAt: fc.constant(offset(172_800_000)),
  }),
  fc.record({
    status: fc.constantFrom("expired", "refunded", "revoked" as const),
    startsAt: fc.constant(offset(-86_400_000)),
    endsAt: fc.constantFrom(null, offset(86_400_000)),
  }),
);

const administrativeGrantArbitrary = fc.tuple(
  fc.uuid({ version: 4 }),
  fc.uuid({ version: 4 }),
  administrativeCapabilityArbitrary,
  statusAndEndArbitrary,
).map(([id, sourceId, capability, state]) => ({
  id,
  accountId,
  capability,
  sourceKind: "administrative" as const,
  sourceId,
  offerCode: null,
  ...state,
}) satisfies EntitlementGrant);

const subscriptionGraceArbitrary = fc.tuple(
  fc.uuid({ version: 4 }),
  fc.uuid({ version: 4 }),
).map(([id, sourceId]) => ({
  id,
  accountId,
  capability: "business_os" as const,
  sourceKind: "subscription" as const,
  sourceId,
  offerCode: "business_os" as const,
  status: "grace" as const,
  startsAt: offset(-86_400_000),
  endsAt: offset(86_400_000),
}) satisfies EntitlementGrant);

const validGrantArbitrary = fc.oneof(
  administrativeGrantArbitrary,
  subscriptionGraceArbitrary,
);

const holdArbitrary = fc.tuple(
  fc.uuid({ version: 4 }),
  fc.uuid({ version: 4 }),
  fc.constantFrom("commerce", "seat_changes", "business_os_activation" as const),
  fc.boolean(),
).map(([id, sourceId, kind, released]) => ({
  id,
  accountId,
  kind,
  sourceKind: "administrative",
  sourceId,
  createdAt: offset(-86_400_000),
  releasedAt: released ? offset(-1) : null,
}) satisfies AccountHold);

function activeSeat(id: string, slot: 1 | 2 | 3): SeatReservation {
  return {
    id,
    accountId,
    slot,
    sourceId: "academy-source",
    state: "active",
    membershipId: `50000000-0000-4000-8000-00000000000${slot}`,
    invitationId: slot === 1
      ? null
      : `60000000-0000-4000-8000-00000000000${slot}`,
    expiresAt: null,
  };
}

function paidBundles(seed: string): readonly EntitlementGrant[] {
  const academyStart = new Date("2024-08-13T12:00:00.000Z");
  const clubStart = new Date("2025-08-13T12:00:00.000Z");
  return [
    {
      id: `${seed.slice(0, -1)}1`, accountId, capability: "academy_course",
      status: "active", sourceKind: "purchase", sourceId: "academy-source",
      offerCode: "self_paced", startsAt: academyStart, endsAt: null,
    },
    {
      id: `${seed.slice(0, -1)}2`, accountId, capability: "support",
      status: "active", sourceKind: "purchase", sourceId: "academy-source",
      offerCode: "self_paced", startsAt: academyStart, endsAt: clubStart,
    },
    {
      id: `${seed.slice(0, -1)}3`, accountId, capability: "circle_write",
      status: "active", sourceKind: "purchase", sourceId: "academy-source",
      offerCode: "self_paced", startsAt: academyStart, endsAt: clubStart,
    },
    {
      id: `${seed.slice(0, -1)}4`, accountId, capability: "support",
      status: "active", sourceKind: "subscription", sourceId: "club-source",
      offerCode: "operator_club_monthly", academySourceId: "academy-source",
      sourceCreatedAt: clubStart, startsAt: clubStart, endsAt: now,
    },
    {
      id: `${seed.slice(0, -1)}5`, accountId, capability: "circle_write",
      status: "active", sourceKind: "subscription", sourceId: "club-source",
      offerCode: "operator_club_monthly", academySourceId: "academy-source",
      sourceCreatedAt: clubStart, startsAt: clubStart, endsAt: now,
    },
    {
      id: `${seed.slice(0, -1)}6`, accountId, capability: "operator_club",
      status: "active", sourceKind: "subscription", sourceId: "club-source",
      offerCode: "operator_club_monthly", academySourceId: "academy-source",
      sourceCreatedAt: clubStart, startsAt: clubStart, endsAt: now,
    },
  ];
}

function permute<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

describe("entitlement properties", () => {
  it("is permutation invariant across grants, holds, and seats including paid bundles", () => {
    fc.assert(fc.property(
      fc.uniqueArray(validGrantArbitrary, {
        selector: ({ id }) => id,
        maxLength: 12,
      }),
      fc.uniqueArray(holdArbitrary, { selector: ({ id }) => id, maxLength: 6 }),
      fc.integer(),
      (administrative, holds, seed) => {
        const grants = [...administrative, ...paidBundles(
          "00000000-0000-4000-8000-000000000100",
        )];
        const seats = [
          activeSeat("00000000-0000-4000-8000-000000000201", 1),
          activeSeat("00000000-0000-4000-8000-000000000202", 2),
        ];
        expect(evaluateEntitlements(input(
          permute(grants, seed),
          permute(holds, seed + 1),
          permute(seats, seed + 2),
        ))).toEqual(evaluateEntitlements(input(grants, holds, seats)));
      },
    ), { seed: 8_130_001, numRuns: 100 });
  });

  it("additive overlapping active sources are all explained in lexical order", () => {
    fc.assert(fc.property(
      administrativeCapabilityArbitrary,
      fc.uniqueArray(fc.uuid({ version: 4 }), { minLength: 2, maxLength: 8 }),
      (capability, ids) => {
        const grants = ids.map((id) => ({
          id, accountId, capability, status: "active" as const,
          sourceKind: "administrative" as const, sourceId: `source-${id}`,
          offerCode: null, startsAt: offset(-1), endsAt: offset(1),
        }));
        const explanation = evaluateEntitlements(input(grants)).explanations
          .find(({ capability: kind }) => kind === capability)!;
        expect(explanation.sourceGrantIds).toEqual([...ids].sort());
      },
    ), { seed: 8_130_002, numRuns: 100 });
  });

  it("inactive sources never negate an active source", () => {
    fc.assert(fc.property(
      administrativeCapabilityArbitrary,
      fc.uniqueArray(validGrantArbitrary, {
        selector: ({ id }) => id,
        maxLength: 12,
      }),
      (kind, grants) => {
        const active: EntitlementGrant = {
          id: "00000000-0000-4000-8000-000000000301", accountId,
          capability: kind, status: "active", sourceKind: "administrative",
          sourceId: "stable-active", offerCode: null,
          startsAt: offset(-1), endsAt: offset(1),
        };
        const inactive = grants.filter(({ id }) => id !== active.id).map((grant) => ({
          ...grant, status: "revoked" as const,
        }));
        expect(evaluateEntitlements(input([active, ...inactive])).capabilities[kind])
          .toBe(true);
      },
    ), { seed: 8_130_003, numRuns: 100 });
  });

  it("uses exact half-open start and end boundaries for active and grace", () => {
    fc.assert(fc.property(administrativeCapabilityArbitrary, (kind) => {
      const atStart: EntitlementGrant = {
        id: "00000000-0000-4000-8000-000000000311", accountId,
        capability: kind, status: "active", sourceKind: "administrative",
        sourceId: "at-start", offerCode: null, startsAt: now, endsAt: offset(1),
      };
      const atEnd: EntitlementGrant = {
        ...atStart, id: "00000000-0000-4000-8000-000000000312",
        sourceId: "at-end", startsAt: offset(-1), endsAt: now,
      };
      const graceAtEnd: EntitlementGrant = {
        ...atEnd, id: "00000000-0000-4000-8000-000000000313",
        sourceId: "grace-at-end", status: "grace",
        capability: "business_os", sourceKind: "subscription",
        offerCode: "business_os",
      };
      expect(evaluateEntitlements(input([atStart])).capabilities[kind]).toBe(true);
      const boundary = evaluateEntitlements(input([atEnd, graceAtEnd]));
      expect(boundary.capabilities[kind]).toBe(false);
      expect(boundary.capabilities.business_os).toBe(false);
    }), { seed: 8_130_004, numRuns: 100 });
  });

  it("holds never change capability results", () => {
    fc.assert(fc.property(
      fc.uniqueArray(validGrantArbitrary, {
        selector: ({ id }) => id,
        maxLength: 12,
      }),
      fc.uniqueArray(holdArbitrary, { selector: ({ id }) => id, maxLength: 6 }),
      (grants, holds) => {
        expect(evaluateEntitlements(input(grants, holds)).capabilities)
          .toEqual(evaluateEntitlements(input(grants)).capabilities);
      },
    ), { seed: 8_130_005, numRuns: 100 });
  });

  it("Business OS grant changes affect no other capability", () => {
    fc.assert(fc.property(
      fc.uniqueArray(administrativeGrantArbitrary, {
        selector: ({ id }) => id,
        maxLength: 12,
      }),
      statusAndEndArbitrary,
      (base, state) => {
        const businessOs: EntitlementGrant = {
          id: "00000000-0000-4000-8000-000000000321", accountId,
          capability: "business_os", sourceKind: "subscription",
          sourceId: "business-os", offerCode: "business_os", ...state,
          endsAt: state.endsAt ?? offset(86_400_000),
        };
        const before = evaluateEntitlements(input(base)).capabilities;
        const after = evaluateEntitlements(input([...base, businessOs])).capabilities;
        for (const kind of CAPABILITIES.filter((item) => item !== "business_os")) {
          expect(after[kind]).toBe(before[kind]);
        }
      },
    ), { seed: 8_130_006, numRuns: 100 });
  });

  it("never derives Academy from Business-OS-only grants", () => {
    fc.assert(fc.property(
      fc.uniqueArray(subscriptionGraceArbitrary, {
        selector: ({ id }) => id,
        maxLength: 16,
      }),
      (grants) => {
        expect(evaluateEntitlements(input(grants)).capabilities.academy_course)
          .toBe(false);
      },
    ), { seed: 8_130_012, numRuns: 100 });
  });

  it("support and Club expiry leave lifetime Academy intact", () => {
    fc.assert(fc.property(fc.integer(), (seed) => {
      const grants = permute(paidBundles(
        "00000000-0000-4000-8000-000000000400",
      ), seed);
      expect(evaluateEntitlements(input(grants)).capabilities).toEqual({
        academy_course: true,
        support: false,
        circle_write: false,
        operator_club: false,
        business_os: false,
      });
    }), { seed: 8_130_007, numRuns: 50 });
  });

  it("rejects duplicate identifiers and cross-account records", () => {
    fc.assert(fc.property(administrativeGrantArbitrary, (grant) => {
      expect(() => evaluateEntitlements(input([grant, { ...grant }])))
        .toThrow("ENTITLEMENT_INPUT_INVALID");
      expect(() => evaluateEntitlements(input([
        { ...grant, accountId: otherAccountId },
      ]))).toThrow("ENTITLEMENT_INPUT_INVALID");
    }), { seed: 8_130_008, numRuns: 100 });
  });

  it("rejects duplicate and cross-account hold or seat records", () => {
    fc.assert(fc.property(holdArbitrary, fc.uuid({ version: 4 }), (hold, seatId) => {
      const validSeat = activeSeat(seatId, 1);
      expect(() => evaluateEntitlements(input([], [hold, { ...hold }], [])))
        .toThrow("ENTITLEMENT_INPUT_INVALID");
      expect(() => evaluateEntitlements(input([], [
        { ...hold, accountId: otherAccountId },
      ], []))).toThrow("ENTITLEMENT_INPUT_INVALID");
      expect(() => evaluateEntitlements(input([], [], [validSeat, { ...validSeat }])))
        .toThrow("ENTITLEMENT_INPUT_INVALID");
      expect(() => evaluateEntitlements(input([], [], [
        { ...validSeat, accountId: otherAccountId },
      ]))).toThrow("ENTITLEMENT_INPUT_INVALID");
    }), { seed: 8_130_013, numRuns: 100 });
  });

  it("deep-freezes every nested result for arbitrary valid input", () => {
    fc.assert(fc.property(
      fc.uniqueArray(validGrantArbitrary, {
        selector: ({ id }) => id,
        maxLength: 12,
      }),
      fc.uniqueArray(holdArbitrary, { selector: ({ id }) => id, maxLength: 6 }),
      (grants, holds) => assertDeepFrozen(evaluateEntitlements(input(grants, holds))),
    ), { seed: 8_130_009, numRuns: 100 });
  });

  it("accepts three funded seats and rejects a fourth occupied epoch", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.uuid({ version: 4 }), { minLength: 4, maxLength: 4 }),
      (ids) => {
        const seats = ids.map((id, index) => ({
          ...activeSeat(id, ([1, 2, 3, 3] as const)[index]!),
          membershipId: `50000000-0000-4000-8000-00000000001${index}`,
          invitationId: index === 0
            ? null
            : `60000000-0000-4000-8000-00000000001${index}`,
        }));
        const academy = paidBundles(
          "00000000-0000-4000-8000-000000000500",
        ).slice(0, 3);
        expect(evaluateEntitlements(input(academy, [], seats.slice(0, 3)))
          .reservedSeats).toBe(3);
        expect(() => evaluateEntitlements(input(academy, [], seats)))
          .toThrow("ENTITLEMENT_INPUT_INVALID");
      },
    ), { seed: 8_130_010, numRuns: 100 });
  });

  it("explanations are complete and sound for finite, future, and grace sources", () => {
    fc.assert(fc.property(
      fc.uniqueArray(validGrantArbitrary, {
        selector: ({ id }) => id,
        maxLength: 16,
      }),
      (grants) => {
        const result = evaluateEntitlements(input(grants));
        expect(result.explanations.map(({ capability }) => capability))
          .toEqual(CAPABILITIES);
        for (const explanation of result.explanations) {
          const expected = grants.filter((grant) =>
            grant.capability === explanation.capability
            && (grant.status === "active" || grant.status === "grace")
            && grant.startsAt.getTime() <= now.getTime()
            && (grant.endsAt === null || now.getTime() < grant.endsAt.getTime()),
          ).map(({ id }) => id).sort();
          expect(explanation.sourceGrantIds).toEqual(expected);
        }
      },
    ), { seed: 8_130_011, numRuns: 100 });
  });
});
