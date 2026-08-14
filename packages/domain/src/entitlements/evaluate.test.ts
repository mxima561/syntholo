import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  HOLD_KINDS,
  evaluateEntitlements,
  oneYearAnniversaryUtc,
  type AccountHold,
  type EntitlementEvaluationInput,
  type EntitlementGrant,
  type SeatReservation,
} from "./index.js";
import {
  includedSupportEndForQualifyingAcademyPurchase,
  isQualifyingAcademySeatSource,
  occupiesAcademyPurchaseSlot,
  qualifyingAcademyPurchase,
} from "./internal.js";

const accountId = "10000000-0000-4000-8000-000000000001";
const otherAccountId = "20000000-0000-4000-8000-000000000002";
const sharedMembershipId = "30000000-0000-4000-8000-000000000003";
const now = new Date("2026-08-13T12:00:00.000Z");

function grant(
  id: string,
  capability: EntitlementGrant["capability"],
  patch: Partial<EntitlementGrant> = {},
): EntitlementGrant {
  return {
    id,
    accountId,
    capability,
    status: "active",
    sourceKind: "administrative",
    sourceId: `source-${id}`,
    offerCode: null,
    startsAt: new Date("2026-01-01T00:00:00.000Z"),
    endsAt: null,
    ...patch,
  };
}

function hold(
  id: string,
  kind: AccountHold["kind"],
  patch: Partial<AccountHold> = {},
): AccountHold {
  return {
    id,
    accountId,
    kind,
    sourceKind: "administrative",
    sourceId: `hold-source-${id}`,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    releasedAt: null,
    ...patch,
  };
}

function seat(
  id: string,
  state: SeatReservation["state"],
  patch: Partial<SeatReservation> = {},
): SeatReservation {
  return {
    id,
    accountId,
    slot: 1,
    sourceId: `academy-${id}`,
    state,
    membershipId:
      state === "active" || state === "revoked" ? id : null,
    invitationId:
      state === "pending" || state === "expired" ? id : null,
    expiresAt:
      state === "pending" || state === "expired"
        ? new Date("2026-08-20T12:00:00.000Z")
        : null,
    ...patch,
  };
}

function fixture(
  patch: Partial<EntitlementEvaluationInput> = {},
): EntitlementEvaluationInput {
  return {
    accountId,
    now,
    grants: [],
    holds: [],
    seats: [],
    ...patch,
  };
}

function academyBundle(
  sourceId: string,
  patch: Partial<EntitlementGrant> = {},
): EntitlementGrant[] {
  const startsAt = new Date("2025-08-13T12:00:00.000Z");
  const endsAt = new Date("2026-08-13T12:00:00.000Z");
  return [
    grant("00000000-0000-4000-8000-000000000111", "academy_course", {
      sourceKind: "purchase", sourceId, offerCode: "self_paced",
      startsAt, endsAt: null, ...patch,
    }),
    grant("00000000-0000-4000-8000-000000000112", "support", {
      sourceKind: "purchase", sourceId, offerCode: "self_paced",
      startsAt, endsAt, ...patch,
    }),
    grant("00000000-0000-4000-8000-000000000113", "circle_write", {
      sourceKind: "purchase", sourceId, offerCode: "self_paced",
      startsAt, endsAt, ...patch,
    }),
  ];
}

function clubBundle(
  sourceId: string,
  patch: Partial<EntitlementGrant> = {},
): EntitlementGrant[] {
  const startsAt = new Date("2026-08-01T12:00:00.000Z");
  const endsAt = new Date("2026-09-01T12:00:00.000Z");
  const sourceCreatedAt = new Date("2026-07-01T12:00:00.000Z");
  return [
    grant("00000000-0000-4000-8000-000000000121", "support", {
      sourceKind: "subscription", sourceId,
      offerCode: "operator_club_monthly", academySourceId: "academy-source",
      sourceCreatedAt, startsAt, endsAt, ...patch,
    }),
    grant("00000000-0000-4000-8000-000000000122", "circle_write", {
      sourceKind: "subscription", sourceId,
      offerCode: "operator_club_monthly", academySourceId: "academy-source",
      sourceCreatedAt, startsAt, endsAt, ...patch,
    }),
    grant("00000000-0000-4000-8000-000000000123", "operator_club", {
      sourceKind: "subscription", sourceId,
      offerCode: "operator_club_monthly", academySourceId: "academy-source",
      sourceCreatedAt, startsAt, endsAt, ...patch,
    }),
  ];
}

describe("evaluateEntitlements", () => {
  it("returns the canonical complete empty decision", () => {
    expect(evaluateEntitlements(fixture())).toEqual({
      accountId,
      capabilities: {
        academy_course: false,
        support: false,
        circle_write: false,
        operator_club: false,
        business_os: false,
      },
      holds: [],
      seatLimit: 3,
      reservedSeats: 0,
      explanations: CAPABILITIES.map((capability) => ({
        capability,
        sourceGrantIds: [],
      })),
    });
    expect(CAPABILITIES).toEqual([
      "academy_course",
      "support",
      "circle_write",
      "operator_club",
      "business_os",
    ]);
    expect(HOLD_KINDS).toEqual([
      "commerce",
      "seat_changes",
      "business_os_activation",
    ]);
  });

  it("uses half-open intervals and only active or bounded grace grants", () => {
    const activeAtStart = grant("00000000-0000-4000-8000-000000000001", "support", {
      startsAt: now,
      endsAt: new Date(now.getTime() + 1),
    });
    const expiredAtEnd = grant("00000000-0000-4000-8000-000000000002", "circle_write", {
      startsAt: new Date(now.getTime() - 1),
      endsAt: now,
    });
    const boundedGrace = grant("00000000-0000-4000-8000-000000000003", "business_os", {
      status: "grace", sourceKind: "subscription", offerCode: "business_os",
      endsAt: new Date(now.getTime() + 1),
    });
    const invalidStatuses = (["expired", "refunded", "revoked"] as const)
      .map((status, index) => grant(
        `00000000-0000-4000-8000-00000000000${index + 4}`,
        "business_os",
        {
          status,
          sourceKind: "subscription",
          offerCode: "business_os",
          endsAt: new Date(now.getTime() + 1),
        },
      ));

    const result = evaluateEntitlements(fixture({
      grants: [activeAtStart, expiredAtEnd, boundedGrace, ...invalidStatuses],
    }));

    expect(result.capabilities).toEqual({
      academy_course: false,
      support: true,
      circle_write: false,
      operator_club: false,
      business_os: true,
    });
  });

  it("keeps lifetime Academy after paired support and Circle expiry", () => {
    const sourceId = "academy-source";
    const startsAt = new Date("2025-08-13T12:00:00.000Z");
    const endsAt = now;
    const grants = [
      grant("00000000-0000-4000-8000-000000000011", "academy_course", {
        sourceKind: "purchase", sourceId, offerCode: "self_paced", startsAt,
      }),
      grant("00000000-0000-4000-8000-000000000012", "support", {
        sourceKind: "purchase", sourceId, offerCode: "self_paced", startsAt, endsAt,
      }),
      grant("00000000-0000-4000-8000-000000000013", "circle_write", {
        sourceKind: "purchase", sourceId, offerCode: "self_paced", startsAt, endsAt,
      }),
    ];

    const result = evaluateEntitlements(fixture({ grants }));

    expect(result.capabilities.academy_course).toBe(true);
    expect(result.capabilities.support).toBe(false);
    expect(result.capabilities.circle_write).toBe(false);
  });

  it("accepts persisted Academy status divergence after included support expires", () => {
    const grants = academyBundle("academy-expired-support").map((item) =>
      item.capability === "academy_course"
        ? { ...item, status: "active" as const }
        : { ...item, status: "expired" as const },
    );

    const result = evaluateEntitlements(fixture({ grants }));

    expect(result.capabilities.academy_course).toBe(true);
    expect(result.capabilities.support).toBe(false);
    expect(result.capabilities.circle_write).toBe(false);
    expect(qualifyingAcademyPurchase(grants, now)).toBe(true);
    expect(includedSupportEndForQualifyingAcademyPurchase(grants, now)?.toISOString())
      .toBe("2026-08-13T12:00:00.000Z");
  });

  it.each(["refunded", "revoked"] as const)(
    "rejects a partially %s Academy bundle",
    (terminalStatus) => {
      const grants = academyBundle(`academy-partial-${terminalStatus}`).map((item) =>
        item.capability === "academy_course"
          ? { ...item, status: terminalStatus }
          : item,
      );
      expect(() => evaluateEntitlements(fixture({ grants })))
        .toThrow("ENTITLEMENT_BUNDLE_INVALID");
    },
  );

  it.each(["expired", "grace"] as const)(
    "rejects an Academy course in %s status",
    (courseStatus) => {
      const grants = academyBundle(`academy-course-${courseStatus}`).map((item) => ({
        ...item, status: courseStatus,
        ...(courseStatus === "grace" && item.capability === "academy_course"
          ? { endsAt: new Date(now.getTime() + 1) }
          : {}),
      }));
      expect(() => evaluateEntitlements(fixture({ grants })))
        .toThrow(courseStatus === "grace"
          ? "ENTITLEMENT_INPUT_INVALID"
          : "ENTITLEMENT_BUNDLE_INVALID");
    },
  );

  it("never lets Business OS source or state gate Academy", () => {
    const onlyBusinessOs = grant(
      "00000000-0000-4000-8000-000000000021",
      "business_os",
      { sourceKind: "subscription", sourceId: "business-os",
        offerCode: "business_os", endsAt: new Date(now.getTime() + 1) },
    );
    const result = evaluateEntitlements(fixture({ grants: [onlyBusinessOs] }));
    expect(result.capabilities.business_os).toBe(true);
    expect(result.capabilities.academy_course).toBe(false);

    const academy = grant(
      "00000000-0000-4000-8000-000000000022",
      "academy_course",
    );
    const revokedBusinessOs = { ...onlyBusinessOs, status: "revoked" as const };
    expect(evaluateEntitlements(fixture({ grants: [academy, revokedBusinessOs] }))
      .capabilities.academy_course).toBe(true);
  });

  it("sorts and deduplicates explanations and holds canonically", () => {
    const grants = [
      grant("00000000-0000-4000-8000-000000000032", "support", { sourceId: "second" }),
      grant("00000000-0000-4000-8000-000000000031", "support", { sourceId: "first" }),
    ];
    const result = evaluateEntitlements(fixture({
      grants,
      holds: [
        hold("00000000-0000-4000-8000-000000000041", "seat_changes"),
        hold("00000000-0000-4000-8000-000000000042", "commerce"),
        hold("00000000-0000-4000-8000-000000000043", "seat_changes"),
        hold("00000000-0000-4000-8000-000000000044", "business_os_activation", {
          releasedAt: now,
        }),
      ],
    }));

    expect(result.holds).toEqual(["commerce", "seat_changes"]);
    expect(result.explanations.find(({ capability }) => capability === "support"))
      .toEqual({
        capability: "support",
        sourceGrantIds: [
          "00000000-0000-4000-8000-000000000031",
          "00000000-0000-4000-8000-000000000032",
        ],
      });
  });

  it("counts active seats and nonexpired pending invitations at an exact boundary", () => {
    const academy = academyBundle("seat-boundary-source");
    const result = evaluateEntitlements(fixture({
      grants: academy,
      seats: [
        seat("00000000-0000-4000-8000-000000000051", "active", {
          slot: 1, sourceId: "seat-boundary-source",
        }),
        seat("00000000-0000-4000-8000-000000000052", "pending", {
          slot: 2, sourceId: "seat-boundary-source",
        }),
        seat("00000000-0000-4000-8000-000000000053", "pending", {
          slot: 3, expiresAt: now, sourceId: "seat-boundary-source",
        }),
        seat("00000000-0000-4000-8000-000000000054", "revoked", {
          slot: 3,
          sourceId: "seat-boundary-source",
          invitationId: "00000000-0000-4000-8000-000000000154",
        }),
      ],
    }));

    expect(result.reservedSeats).toBe(2);
  });

  it("accepts all three funded slots and rejects a fourth occupied epoch", () => {
    const academy = academyBundle("seat-capacity-source");
    const firstThree = [
      seat("00000000-0000-4000-8000-000000000060", "active", {
        slot: 1, sourceId: "seat-capacity-source",
      }),
      seat("00000000-0000-4000-8000-000000000061", "active", {
        slot: 2, sourceId: "seat-capacity-source",
        invitationId: "40000000-0000-4000-8000-000000000061",
      }),
      seat("00000000-0000-4000-8000-000000000062", "active", {
        slot: 3, sourceId: "seat-capacity-source",
        invitationId: "40000000-0000-4000-8000-000000000062",
      }),
    ];
    expect(evaluateEntitlements(fixture({ grants: academy, seats: firstThree }))
      .reservedSeats).toBe(3);

    expect(() => evaluateEntitlements(fixture({
      grants: academy,
      seats: [...firstThree, seat(
        "00000000-0000-4000-8000-000000000063",
        "active",
        {
          slot: 3,
          sourceId: "seat-capacity-source",
          invitationId: "40000000-0000-4000-8000-000000000063",
        },
      )],
    }))).toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it.each([
    ["duplicate grant ids", { grants: [grant("00000000-0000-4000-8000-000000000071", "support"), grant("00000000-0000-4000-8000-000000000071", "circle_write")] }],
    ["cross-account grants", { grants: [grant("00000000-0000-4000-8000-000000000072", "support", { accountId: otherAccountId })] }],
    ["invalid clock", { now: new Date(Number.NaN) }],
    ["unbounded grace", { grants: [grant("00000000-0000-4000-8000-000000000073", "support", { status: "grace", endsAt: null })] }],
    ["administrative grace", { grants: [grant("00000000-0000-4000-8000-00000000007a", "support", { status: "grace", endsAt: new Date(now.getTime() + 1) })] }],
    ["inverted interval", { grants: [grant("00000000-0000-4000-8000-000000000074", "support", { endsAt: new Date("2025-01-01T00:00:00.000Z") })] }],
    ["cross-account holds", { holds: [hold("00000000-0000-4000-8000-000000000075", "commerce", { accountId: otherAccountId })] }],
    ["cross-account seats", { seats: [seat("00000000-0000-4000-8000-000000000076", "active", { accountId: otherAccountId })] }],
    ["duplicate hold ids", { holds: [hold("00000000-0000-4000-8000-000000000077", "commerce"), hold("00000000-0000-4000-8000-000000000077", "seat_changes")] }],
    ["duplicate seat ids", { seats: [seat("00000000-0000-4000-8000-000000000078", "active"), seat("00000000-0000-4000-8000-000000000078", "revoked")] }],
    ["released hold before creation", { holds: [hold("00000000-0000-4000-8000-000000000079", "commerce", { releasedAt: new Date("2026-07-01T00:00:00.000Z") })] }],
  ])("rejects %s", (_label, patch) => {
    expect(() => evaluateEntitlements(fixture(patch))).toThrow(
      "ENTITLEMENT_INPUT_INVALID",
    );
  });

  it("rejects purchase-sourced Business OS grace", () => {
    const businessOs = grant(
      "00000000-0000-4000-8000-00000000007b",
      "business_os",
      {
        status: "grace", sourceKind: "purchase", sourceId: "business-os-grace",
        offerCode: "business_os", endsAt: new Date(now.getTime() + 1),
      },
    );
    expect(() => evaluateEntitlements(fixture({ grants: [businessOs] })))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it.each([
    ["administrative", {
      sourceKind: "administrative" as const,
      sourceId: "manual-business-os",
      offerCode: null,
      endsAt: new Date(now.getTime() + 1),
    }],
    ["purchase", {
      sourceKind: "purchase" as const,
      sourceId: "setup-fee-business-os",
      offerCode: "business_os" as const,
      endsAt: new Date(now.getTime() + 1),
    }],
    ["unbounded subscription", {
      sourceKind: "subscription" as const,
      sourceId: "unbounded-business-os",
      offerCode: "business_os" as const,
      endsAt: null,
    }],
  ])("rejects %s Business OS access grants", (_label, patch) => {
    const businessOs = grant(
      "00000000-0000-4000-8000-00000000007c",
      "business_os",
      patch,
    );
    expect(() => evaluateEntitlements(fixture({ grants: [businessOs] })))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it.each([
    ["pending with a member", [
      seat("00000000-0000-4000-8000-000000000175", "pending", { membershipId: sharedMembershipId }),
    ]],
    ["pending without an invitation", [
      seat("00000000-0000-4000-8000-000000000176", "pending", { invitationId: null }),
    ]],
    ["pending without an expiry", [
      seat("00000000-0000-4000-8000-000000000177", "pending", { expiresAt: null }),
    ]],
    ["active owner with invitation expiry", [
      seat("00000000-0000-4000-8000-000000000178", "active", { expiresAt: new Date(now.getTime() + 1) }),
    ]],
    ["active without membership", [
      seat("00000000-0000-4000-8000-000000000179", "active", { membershipId: null }),
    ]],
  ])("rejects invalid seat state: %s", (_label, seats) => {
    expect(() => evaluateEntitlements(fixture({ seats })))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("accepts invitation-origin occupancy in slot one after ownership transfer", () => {
    const academy = academyBundle("transferred-owner-slot-source");
    const invitationId = "60000000-0000-4000-8000-000000000001";
    const pending = seat("00000000-0000-4000-8000-000000000180", "pending", {
      slot: 1,
      sourceId: "transferred-owner-slot-source",
      invitationId,
    });
    expect(evaluateEntitlements(fixture({ grants: academy, seats: [pending] })).reservedSeats)
      .toBe(1);
    const active = seat("00000000-0000-4000-8000-000000000181", "active", {
      slot: 1,
      sourceId: "transferred-owner-slot-source",
      invitationId,
    });
    expect(evaluateEntitlements(fixture({ grants: academy, seats: [active] })).reservedSeats)
      .toBe(1);
  });

  it("rejects a duplicate occupied slot after both rows pass shape and funding validation", () => {
    const academy = academyBundle("duplicate-slot-source");
    const seats = [
      seat("00000000-0000-4000-8000-000000000171", "active", {
        slot: 2,
        sourceId: "duplicate-slot-source",
        invitationId: "40000000-0000-4000-8000-000000000171",
      }),
      seat("00000000-0000-4000-8000-000000000172", "active", {
        slot: 2,
        sourceId: "duplicate-slot-source",
        invitationId: "40000000-0000-4000-8000-000000000172",
      }),
    ];
    expect(() => evaluateEntitlements(fixture({ grants: academy, seats })))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("rejects a duplicate active membership after both rows are funded", () => {
    const academy = academyBundle("duplicate-membership-source");
    const seats = [
      seat("00000000-0000-4000-8000-000000000173", "active", {
        slot: 1,
        sourceId: "duplicate-membership-source",
        membershipId: sharedMembershipId,
      }),
      seat("00000000-0000-4000-8000-000000000174", "active", {
        slot: 2,
        sourceId: "duplicate-membership-source",
        membershipId: sharedMembershipId,
        invitationId: "40000000-0000-4000-8000-000000000004",
      }),
    ];
    expect(() => evaluateEntitlements(fixture({ grants: academy, seats })))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("rejects an otherwise valid occupied seat without a matching Academy bundle", () => {
    const orphan = seat("00000000-0000-4000-8000-000000000175", "active", {
      sourceId: "missing-academy-source",
    });
    expect(() => evaluateEntitlements(fixture({ seats: [orphan] })))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("keeps immutable invitation linkage on an activated teammate seat", () => {
    const academy = academyBundle("teammate-seat-source");
    const teammate = seat(
      "00000000-0000-4000-8000-000000000179",
      "active",
      {
        slot: 2, invitationId: "00000000-0000-4000-8000-000000000279",
        expiresAt: null, sourceId: "teammate-seat-source",
      },
    );
    expect(evaluateEntitlements(fixture({ grants: academy, seats: [teammate] })).reservedSeats)
      .toBe(1);
  });

  it("rejects a teammate seat that lost its invitation linkage", () => {
    const teammate = seat(
      "00000000-0000-4000-8000-00000000018a",
      "active",
      { slot: 2, invitationId: null, expiresAt: null },
    );
    expect(() => evaluateEntitlements(fixture({ seats: [teammate] })))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("rejects a duplicated logical invitation across reservation history", () => {
    const invitationId = "40000000-0000-4000-8000-000000000005";
    expect(() => evaluateEntitlements(fixture({ seats: [
      seat("00000000-0000-4000-8000-00000000018b", "expired", {
        slot: 2, invitationId,
      }),
      seat("00000000-0000-4000-8000-00000000018c", "active", {
        slot: 3, invitationId,
      }),
    ] }))).toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("rejects an occupied seat without a complete active Academy funding bundle", () => {
    expect(() => evaluateEntitlements(fixture({ seats: [
      seat("00000000-0000-4000-8000-00000000018f", "active", {
        sourceId: "business-os",
      }),
    ] }))).toThrow("ENTITLEMENT_INPUT_INVALID");
    const academy = academyBundle("academy-seat-source");
    expect(evaluateEntitlements(fixture({ grants: academy, seats: [
      seat("00000000-0000-4000-8000-000000000190", "active", {
        sourceId: "academy-seat-source",
      }),
    ] })).reservedSeats).toBe(1);
  });

  it("preserves terminal seat history against a terminal complete Academy source", () => {
    const refunded = academyBundle("refunded-seat-source").map((item) => ({
      ...item, status: "refunded" as const,
    }));
    expect(evaluateEntitlements(fixture({ grants: refunded, seats: [
      seat("00000000-0000-4000-8000-000000000193", "revoked", {
        sourceId: "refunded-seat-source",
      }),
    ] })).reservedSeats).toBe(0);
  });

  it.each([
    ["membership", seat("00000000-0000-4000-8000-00000000018d", "active", {
      membershipId: "not-a-uuid",
    })],
    ["invitation", seat("00000000-0000-4000-8000-00000000018e", "pending", {
      invitationId: "not-a-uuid",
    })],
  ])("rejects a noncanonical %s foreign-key identity", (_label, invalidSeat) => {
    expect(() => evaluateEntitlements(fixture({ seats: [invalidSeat] })))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("rejects duplicate storage identities for grants and holds", () => {
    const firstGrant = grant(
      "00000000-0000-4000-8000-00000000018f", "support",
      { sourceId: "same-source" },
    );
    expect(() => evaluateEntitlements(fixture({ grants: [
      firstGrant,
      { ...firstGrant, id: "00000000-0000-4000-8000-000000000190" },
    ] }))).toThrow("ENTITLEMENT_INPUT_INVALID");
    const firstHold = hold(
      "00000000-0000-4000-8000-000000000191", "commerce",
      { sourceId: "same-dispute" },
    );
    expect(() => evaluateEntitlements(fixture({ holds: [
      firstHold,
      { ...firstHold, id: "00000000-0000-4000-8000-000000000192" },
    ] }))).toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it.each([
    ["incomplete Academy", [academyBundle("academy-incomplete")[0]!]],
    ["unequal Academy support end", academyBundle("academy-end").map((item) =>
      item.capability === "support"
        ? { ...item, endsAt: new Date("2026-08-13T12:00:00.001Z") }
        : item)],
    ["unequal Academy Circle start", academyBundle("academy-start").map((item) =>
      item.capability === "circle_write"
        ? { ...item, startsAt: new Date("2025-08-13T12:00:00.001Z") }
        : item)],
    ["unequal Academy status", academyBundle("academy-status").map((item) =>
      item.capability === "support" ? { ...item, status: "expired" as const } : item)],
    ["Academy carrying a Club parent", academyBundle("academy-parent").map((item) => ({
      ...item, academySourceId: "forged-parent",
    }))],
    ["mismatched Academy support and Circle status", academyBundle("academy-status-pair").map((item) =>
      item.capability === "support" ? { ...item, status: "expired" as const } : item)],
    ["mixed Academy offer", academyBundle("academy-offer").map((item) =>
      item.capability === "support" ? { ...item, offerCode: "guided_pilot" as const } : item)],
    ["mixed Academy source kind", academyBundle("academy-kind").map((item) =>
      item.capability === "support" ? { ...item, sourceKind: "administrative" as const } : item)],
    ["incomplete Club", clubBundle("club-incomplete").slice(0, 2)],
    ["unequal Club end", clubBundle("club-end").map((item) =>
      item.capability === "support"
        ? { ...item, endsAt: new Date("2026-09-01T12:00:00.001Z") }
        : item)],
    ["unequal Club start", clubBundle("club-start").map((item) =>
      item.capability === "circle_write"
        ? { ...item, startsAt: new Date("2026-08-01T12:00:00.001Z") }
        : item)],
    ["unequal Club status", clubBundle("club-status").map((item) =>
      item.capability === "operator_club"
        ? { ...item, status: "revoked" as const }
        : item)],
    ["partial Club parent", clubBundle("club-parent-missing").map((item) =>
      item.capability === "operator_club"
        ? { ...item, academySourceId: null }
        : item)],
    ["mismatched Club parent", clubBundle("club-parent-mismatch").map((item) =>
      item.capability === "operator_club"
        ? { ...item, academySourceId: "other-academy" }
        : item)],
  ])("rejects malformed %s bundle", (label, grants) => {
    expect(() => evaluateEntitlements(fixture({ grants })))
      .toThrow(label === "Academy carrying a Club parent"
        || label === "partial Club parent"
        || label === "mixed Academy offer"
        || label === "mismatched Club parent"
        ? "ENTITLEMENT_INPUT_INVALID"
        : "ENTITLEMENT_BUNDLE_INVALID");
  });

  it("allows independently scoped administrative grants without a bundle", () => {
    const administrative = grant(
      "00000000-0000-4000-8000-000000000131",
      "support",
    );
    expect(evaluateEntitlements(fixture({ grants: [administrative] }))
      .capabilities.support).toBe(true);
  });

  it("does not mistake an administrative Club-labeled grant for a Club bundle", () => {
    const administrative = grant(
      "00000000-0000-4000-8000-000000000134",
      "support",
      { offerCode: "operator_club_monthly" },
    );
    const result = evaluateEntitlements(fixture({ grants: [administrative] }));
    expect(result.capabilities.support).toBe(true);
    expect(result.explanations.find(({ capability }) => capability === "support"))
      .toEqual({ capability: "support", sourceGrantIds: [administrative.id] });
  });

  it.each([
    ["administrative", [grant(
      "00000000-0000-4000-8000-000000000132", "support",
      { academySourceId: "forged-parent" },
    )]],
    ["Business OS", [grant(
      "00000000-0000-4000-8000-000000000133", "business_os",
      {
        sourceKind: "purchase", sourceId: "business-os-parent",
        offerCode: "business_os", academySourceId: "forged-parent",
      },
    )]],
  ])("rejects a forged Club parent on %s grants", (_label, grants) => {
    expect(() => evaluateEntitlements(fixture({ grants })))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("deep freezes all returned structures", () => {
    const result = evaluateEntitlements(fixture({
      grants: [grant("00000000-0000-4000-8000-000000000091", "support")],
      holds: [hold("00000000-0000-4000-8000-000000000092", "commerce")],
    }));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
    expect(Object.isFrozen(result.holds)).toBe(true);
    expect(Object.isFrozen(result.explanations)).toBe(true);
    expect(result.explanations.every((item) =>
      Object.isFrozen(item) && Object.isFrozen(item.sourceGrantIds),
    )).toBe(true);
  });

  it("qualifies only a complete interval-effective Academy purchase bundle", () => {
    const atStartSupportEnd = oneYearAnniversaryUtc(now);
    const atStart = academyBundle("effective-academy").map((item) => ({
      ...item,
      offerCode: "guided_pilot" as const,
      startsAt: now,
      ...(item.capability === "academy_course"
        ? { endsAt: null }
        : { endsAt: atStartSupportEnd }),
    }));
    expect(qualifyingAcademyPurchase(atStart, now)).toBe(true);
    const futureStart = new Date(now.getTime() + 1);
    expect(qualifyingAcademyPurchase(atStart.map((item) => ({
      ...item, startsAt: futureStart,
      endsAt: item.capability === "academy_course"
        ? null
        : oneYearAnniversaryUtc(futureStart),
    })), now)).toBe(false);
    const priorStart = new Date(now.getTime() - 1);
    expect(qualifyingAcademyPurchase(atStart.map((item) => ({
      ...item,
      startsAt: priorStart,
      endsAt: item.capability === "academy_course"
        ? null
        : oneYearAnniversaryUtc(priorStart),
    })), now)).toBe(true);
    expect(qualifyingAcademyPurchase(atStart.map((item) => ({
      ...item, status: "refunded" as const,
    })), now)).toBe(false);
    expect(qualifyingAcademyPurchase(atStart.map((item) => ({
      ...item, status: "revoked" as const,
    })), now)).toBe(false);
    expect(qualifyingAcademyPurchase(atStart.map((item) => ({
      ...item, sourceKind: "administrative" as const,
    })), now)).toBe(false);
    expect(() => qualifyingAcademyPurchase(atStart.map((item) => ({
      ...item, offerCode: "business_os" as const,
    })), now)).toThrow("ENTITLEMENT_BUNDLE_INVALID");
    expect(() => qualifyingAcademyPurchase([atStart[0]!], now))
      .toThrow("ENTITLEMENT_BUNDLE_INVALID");
  });

  it("rejects malformed Academy grace while structurally reserving its source", () => {
    const grace = academyBundle("grace-academy").map((item) => ({
      ...item, status: "grace" as const,
      ...(item.capability === "academy_course"
        ? { endsAt: new Date(now.getTime() + 1) }
        : {}),
    }));
    expect(() => qualifyingAcademyPurchase(grace, now))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
    expect(isQualifyingAcademySeatSource(grace, "grace-academy")).toBe(false);
    expect(occupiesAcademyPurchaseSlot(grace[0]!)).toBe(true);
  });

  it("allows terminal Academy history plus one new purchase slot", () => {
    const terminal = academyBundle("terminal-history").map((item) => ({
      ...item, status: "refunded" as const,
    }));
    const nextStart = new Date("2027-08-13T12:00:00.000Z");
    const next = academyBundle("new-purchase").map((item, index) => ({
      ...item,
      id: `00000000-0000-4000-8000-00000000031${index}`,
      startsAt: nextStart,
      endsAt: item.capability === "academy_course"
        ? null
        : oneYearAnniversaryUtc(nextStart),
    }));
    expect(() => evaluateEntitlements(fixture({ grants: [...terminal, ...next] })))
      .not.toThrow();
  });

  it("counts a malformed legacy Academy grace row in structural uniqueness", () => {
    const active = academyBundle("active-purchase");
    const legacyGrace = {
      ...active[0]!,
      id: "00000000-0000-4000-8000-000000000319",
      sourceId: "legacy-grace-purchase",
      status: "grace" as const,
      endsAt: new Date(now.getTime() + 1),
    };
    expect(occupiesAcademyPurchaseSlot(legacyGrace)).toBe(true);
    expect(() => evaluateEntitlements(fixture({
      grants: [...active, legacyGrace],
    }))).toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("rejects duplicate qualifying runtime Academy sources", () => {
    const startsAt = new Date(now.getTime() - 1);
    const endsAt = oneYearAnniversaryUtc(startsAt);
    const first = academyBundle("first-effective").map((item) => ({
      ...item, startsAt,
      ...(item.capability === "academy_course"
        ? { endsAt: null }
        : { endsAt }),
    }));
    const second = academyBundle("second-effective").map((item, index) => ({
      ...item, id: `00000000-0000-4000-8000-00000000019${index + 4}`,
      startsAt,
      ...(item.capability === "academy_course"
        ? { endsAt: null }
        : { endsAt }),
    }));
    expect(() => qualifyingAcademyPurchase([...first, ...second], now))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
    expect(() => qualifyingAcademyPurchase([
      ...first,
      ...second.map((item) => ({ ...item, accountId: otherAccountId })),
    ], now)).toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("rejects two scheduled-future Academy purchases structurally", () => {
    const firstStart = new Date("2027-08-13T12:00:00.000Z");
    const secondStart = new Date("2028-08-13T12:00:00.000Z");
    const first = academyBundle("future-structural-one").map((item) => ({
      ...item, startsAt: firstStart,
      endsAt: item.capability === "academy_course"
        ? null
        : oneYearAnniversaryUtc(firstStart),
    }));
    const second = academyBundle("future-structural-two").map((item, index) => ({
      ...item, id: `00000000-0000-4000-8000-00000000029${index + 1}`,
      startsAt: secondStart,
      endsAt: item.capability === "academy_course"
        ? null
        : oneYearAnniversaryUtc(secondStart),
    }));
    expect(() => evaluateEntitlements(fixture({ grants: [...first, ...second] })))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("does not let one valid Academy source hide a malformed paid source", () => {
    const valid = academyBundle("valid-effective").map((item) => ({
      ...item, startsAt: new Date(now.getTime() - 1),
      ...(item.capability === "academy_course"
        ? { endsAt: null }
        : { endsAt: new Date(now.getTime() + 1) }),
    }));
    const malformed = grant(
      "00000000-0000-4000-8000-000000000198",
      "academy_course",
      {
        sourceKind: "purchase", sourceId: "malformed-extra",
        offerCode: "self_paced", startsAt: new Date(now.getTime() - 1),
      },
    );
    expect(() => qualifyingAcademyPurchase([...valid, malformed], now))
      .toThrow("ENTITLEMENT_INPUT_INVALID");
  });

  it("distinguishes scheduled-future seat funding from runtime Club eligibility", () => {
    const futureStart = new Date(now.getTime() + 1);
    const futureBundle = academyBundle("future-academy").map((item) => ({
      ...item, startsAt: futureStart,
      ...(item.capability === "academy_course"
        ? { endsAt: null }
        : { endsAt: oneYearAnniversaryUtc(futureStart) }),
    }));
    const future = futureBundle[0]!;
    expect(isQualifyingAcademySeatSource(futureBundle, "future-academy")).toBe(true);
    expect(qualifyingAcademyPurchase(futureBundle, now)).toBe(false);
    expect(isQualifyingAcademySeatSource(futureBundle.map((item) => ({
      ...item, status: "grace" as const,
    })), "future-academy"))
      .toBe(false);
    expect(isQualifyingAcademySeatSource(futureBundle.map((item) => ({
      ...item, status: "refunded" as const,
    })), "future-academy"))
      .toBe(false);
    expect(isQualifyingAcademySeatSource(futureBundle.map((item) => ({
      ...item, sourceKind: "administrative" as const,
    })), "future-academy"))
      .toBe(false);
    expect(isQualifyingAcademySeatSource(futureBundle.map((item) => ({
      ...item, offerCode: "business_os" as const,
    })), "future-academy"))
      .toBe(false);
    expect(isQualifyingAcademySeatSource(futureBundle.map((item) => ({
      ...item, capability: "business_os" as const,
    })), "future-academy"))
      .toBe(false);
    expect(isQualifyingAcademySeatSource(futureBundle.map((item) => ({
      ...item,
      ...(item.capability === "academy_course"
        ? { endsAt: new Date(future.startsAt.getTime() - 1) }
        : {}),
    })), "future-academy")).toBe(false);
    expect(isQualifyingAcademySeatSource(futureBundle, ""))
      .toBe(false);
    expect(isQualifyingAcademySeatSource([
      { ...future, id: "not-a-uuid" }, ...futureBundle.slice(1),
    ], "future-academy"))
      .toBe(false);
    expect(isQualifyingAcademySeatSource(futureBundle.map((item) => ({
      ...item, accountId: "not-a-uuid",
    })), "future-academy"))
      .toBe(false);
    expect(isQualifyingAcademySeatSource(futureBundle.map((item) => ({
      ...item, academySourceId: "forged-parent",
    })), "future-academy"))
      .toBe(false);
    expect(isQualifyingAcademySeatSource([future], "future-academy")).toBe(false);
  });

  it("pairs Club scheduling to the exact qualifying Academy source", () => {
    const startsAt = new Date(now.getTime() - 1);
    const endsAt = oneYearAnniversaryUtc(startsAt);
    const bundle = academyBundle("paired-academy").map((item) => ({
      ...item, startsAt,
      ...(item.capability === "academy_course"
        ? { endsAt: null }
        : { endsAt }),
    }));
    const unrelated = grant("00000000-0000-4000-8000-000000000199", "support", {
      startsAt: new Date(now.getTime() - 1),
      endsAt: new Date(now.getTime() + 63_072_000_000),
    });
    expect(includedSupportEndForQualifyingAcademyPurchase(
      [...bundle, unrelated],
      now,
    )?.toISOString()).toBe(endsAt.toISOString());
    expect(() => includedSupportEndForQualifyingAcademyPurchase([
      bundle[0]!, unrelated,
    ], now)).toThrow("ENTITLEMENT_BUNDLE_INVALID");
  });

  it.each([
    ["active", "active", true],
    ["future", "active", false],
    ["refunded", "refunded", false],
    ["revoked", "revoked", false],
  ] as const)(
    "gates an effective Club bundle on its exact %s parent Academy",
    (label, academyStatus, expected) => {
      const academyStart = label === "active"
        ? new Date("2025-08-13T12:00:00.000Z")
        : label === "refunded" || label === "revoked"
          ? new Date("2025-08-13T12:00:00.000Z")
          : new Date("2027-08-13T12:00:00.000Z");
      const academyEnd = oneYearAnniversaryUtc(academyStart);
      const academy = academyBundle("academy-source").map((item) => ({
        ...item,
        status: academyStatus,
        startsAt: academyStart,
        endsAt: item.capability === "academy_course" ? null : academyEnd,
      }));
      const clubEnd = new Date(academyEnd.getTime() + 31 * 86_400_000);
      const club = clubBundle("club-parented").map((item) => ({
        ...item,
        startsAt: academyEnd,
        endsAt: clubEnd,
      }));
      const evaluationNow = expected
        ? new Date(academyEnd.getTime())
        : new Date("2026-08-13T12:00:00.000Z");
      const result = evaluateEntitlements({
        ...fixture({ grants: [...academy, ...club] }), now: evaluationNow,
      });
      expect(result.capabilities.operator_club).toBe(expected);
      expect(result.explanations.find(({ capability }) =>
        capability === "operator_club")?.sourceGrantIds.length).toBe(expected ? 1 : 0);
    },
  );

  it("validates scheduled and late Club starts against source creation time", () => {
    const academyStart = new Date("2025-01-01T12:00:00.000Z");
    const supportEnd = oneYearAnniversaryUtc(academyStart);
    const academy = academyBundle("academy-source").map((item) => ({
      ...item,
      startsAt: academyStart,
      endsAt: item.capability === "academy_course" ? null : supportEnd,
    }));
    const scheduledCreated = new Date(supportEnd.getTime() - 1);
    const scheduled = clubBundle("scheduled-club").map((item) => ({
      ...item,
      sourceCreatedAt: scheduledCreated,
      startsAt: supportEnd,
      endsAt: new Date(supportEnd.getTime() + 31 * 86_400_000),
    }));
    expect(() => evaluateEntitlements({
      ...fixture(), now: supportEnd, grants: [...academy, ...scheduled],
    })).not.toThrow();

    const lateCreated = new Date(supportEnd.getTime() + 86_400_000);
    const late = clubBundle("late-club").map((item) => ({
      ...item,
      sourceCreatedAt: lateCreated,
      startsAt: lateCreated,
      endsAt: new Date(lateCreated.getTime() + 31 * 86_400_000),
    }));
    expect(() => evaluateEntitlements({
      ...fixture(), now: lateCreated, grants: [...academy, ...late],
    })).not.toThrow();
    expect(() => evaluateEntitlements({
      ...fixture(), now: lateCreated, grants: [...academy, ...late.map((item) => ({
        ...item, startsAt: supportEnd,
      }))],
    })).toThrow("ENTITLEMENT_BUNDLE_INVALID");
  });

  it("does not reattach an old Club to a replacement Academy and suppresses its full bundle", () => {
    const oldStart = new Date("2025-08-13T12:00:00.000Z");
    const oldEnd = oneYearAnniversaryUtc(oldStart);
    const oldAcademy = academyBundle("academy-source").map((item) => ({
      ...item,
      status: "refunded" as const,
      startsAt: oldStart,
      endsAt: item.capability === "academy_course" ? null : oldEnd,
    }));
    const club = clubBundle("old-club").map((item) => ({
      ...item,
      startsAt: oldEnd,
      endsAt: new Date(oldEnd.getTime() + 31 * 86_400_000),
    }));
    const replacementStart = new Date("2026-01-01T00:00:00.000Z");
    const replacement = academyBundle("replacement-academy").map((item, index) => ({
      ...item,
      id: `00000000-0000-4000-8000-00000000032${index}`,
      startsAt: replacementStart,
      endsAt: item.capability === "academy_course"
        ? null
        : oneYearAnniversaryUtc(replacementStart),
    }));
    const admin = [
      grant("00000000-0000-4000-8000-000000000331", "support", {
        offerCode: "operator_club_monthly",
      }),
      grant("00000000-0000-4000-8000-000000000332", "circle_write", {
        offerCode: "operator_club_monthly",
      }),
      grant("00000000-0000-4000-8000-000000000333", "operator_club", {
        offerCode: "operator_club_monthly",
      }),
    ];
    const result = evaluateEntitlements(fixture({
      grants: [...oldAcademy, ...club, ...replacement, ...admin],
    }));
    for (const capability of ["support", "circle_write", "operator_club"] as const) {
      const explanation = result.explanations.find((item) =>
        item.capability === capability)!;
      expect(explanation.sourceGrantIds).not.toContain(
        club.find((item) => item.capability === capability)!.id,
      );
      expect(explanation.sourceGrantIds).toContain(
        admin.find((item) => item.capability === capability)!.id,
      );
      if (capability !== "operator_club") {
        expect(explanation.sourceGrantIds).toContain(
          replacement.find((item) => item.capability === capability)!.id,
        );
      }
    }
  });

  it("contains no certificate capability", () => {
    expect(CAPABILITIES).not.toContain("certificate");
    expect(Object.keys(evaluateEntitlements(fixture()).capabilities))
      .not.toContain("certificate");
  });
});
