import type { EntitlementEvaluationInput } from "@syntholo/domain";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalEntitlementSnapshotHashV1,
  publicBusinessOsReconciliationReasons,
  TransactionEntitlementRepository,
} from "./entitlements.js";

const accountId = "10000000-0000-4000-8000-000000000001";
const startsAt = new Date("2026-01-01T12:00:00.123Z");
const supportEndsAt = new Date("2027-01-01T12:00:00.123Z");

function snapshot(): EntitlementEvaluationInput {
  return {
    accountId,
    now: new Date("2026-08-13T12:00:00.123Z"),
    grants: [
      {
        id: "10000000-0000-4000-8000-000000000101",
        accountId,
        capability: "academy_course",
        status: "active",
        sourceKind: "purchase",
        sourceId: "purchase_snapshot",
        offerCode: "self_paced",
        academySourceId: undefined,
        startsAt,
        endsAt: null,
      },
      {
        id: "10000000-0000-4000-8000-000000000102",
        accountId,
        capability: "support",
        status: "active",
        sourceKind: "purchase",
        sourceId: "purchase_snapshot",
        offerCode: "self_paced",
        academySourceId: null,
        startsAt,
        endsAt: supportEndsAt,
      },
      {
        id: "10000000-0000-4000-8000-000000000103",
        accountId,
        capability: "circle_write",
        status: "active",
        sourceKind: "purchase",
        sourceId: "purchase_snapshot",
        offerCode: "self_paced",
        startsAt,
        endsAt: supportEndsAt,
      },
    ],
    holds: [
      {
        id: "10000000-0000-4000-8000-000000000201",
        accountId,
        kind: "commerce",
        sourceKind: "stripe_dispute",
        sourceId: "dp_snapshot",
        createdAt: new Date("2026-08-12T12:00:00.123Z"),
        releasedAt: null,
      },
      {
        id: "10000000-0000-4000-8000-000000000202",
        accountId,
        kind: "seat_changes",
        sourceKind: "staff_review",
        sourceId: "review_snapshot",
        createdAt: new Date("2026-08-11T12:00:00.123Z"),
        releasedAt: new Date("2026-08-12T12:00:00.123Z"),
      },
    ],
    seats: [
      {
        id: "10000000-0000-4000-8000-000000000301",
        accountId,
        slot: 1,
        sourceId: "purchase_snapshot",
        state: "active",
        membershipId: "10000000-0000-4000-8000-000000000401",
        invitationId: null,
        expiresAt: null,
      },
      {
        id: "10000000-0000-4000-8000-000000000302",
        accountId,
        slot: 2,
        sourceId: "purchase_snapshot",
        state: "pending",
        membershipId: null,
        invitationId: "10000000-0000-4000-8000-000000000402",
        expiresAt: new Date("2026-08-14T12:00:00.123Z"),
      },
    ],
  };
}

describe("canonicalEntitlementSnapshotHashV1", () => {
  it("is permutation-invariant and normalizes optional null fields", () => {
    const original = snapshot();
    const permuted: EntitlementEvaluationInput = {
      ...original,
      grants: [...original.grants].reverse().map((grant) => ({
        ...grant,
        academySourceId: grant.academySourceId ?? null,
      })),
      holds: [...original.holds].reverse(),
      seats: [...original.seats].reverse(),
    };

    expect(canonicalEntitlementSnapshotHashV1(permuted)).toBe(
      canonicalEntitlementSnapshotHashV1(original),
    );
  });

  it("changes when a material snapshot field changes", () => {
    const original = snapshot();
    const changed: EntitlementEvaluationInput = {
      ...original,
      holds: original.holds.map((hold, index) => index === 0
        ? { ...hold, sourceId: "dp_snapshot_changed" }
        : hold),
    };

    expect(canonicalEntitlementSnapshotHashV1(changed)).not.toBe(
      canonicalEntitlementSnapshotHashV1(original),
    );
  });

  it("binds account time and every grant hold and seat section", () => {
    const original = snapshot();
    const baseline = canonicalEntitlementSnapshotHashV1(original);
    const otherAccount = "20000000-0000-4000-8000-000000000002";
    const changed: readonly EntitlementEvaluationInput[] = [
      { ...original, now: new Date(original.now.getTime() + 1) },
      {
        ...original,
        accountId: otherAccount,
        grants: original.grants.map((grant) => ({ ...grant, accountId: otherAccount })),
        holds: original.holds.map((hold) => ({ ...hold, accountId: otherAccount })),
        seats: original.seats.map((seat) => ({ ...seat, accountId: otherAccount })),
      },
      {
        ...original,
        grants: original.grants.map((grant, index) => index === 0
          ? { ...grant, id: "10000000-0000-4000-8000-000000000104" }
          : grant),
      },
      {
        ...original,
        grants: original.grants.map((grant) => ({
          ...grant,
          sourceId: "purchase_snapshot_changed",
        })),
        seats: original.seats.map((seat) => ({
          ...seat,
          sourceId: "purchase_snapshot_changed",
        })),
      },
      {
        ...original,
        grants: original.grants.map((grant) => ({
          ...grant,
          offerCode: "guided_pilot" as const,
        })),
      },
      {
        ...original,
        grants: original.grants.map((grant) => grant.capability === "academy_course"
          ? grant
          : { ...grant, status: "expired" as const }),
      },
      {
        ...original,
        grants: original.grants.map((grant) => ({
          ...grant,
          sourceCreatedAt: startsAt,
        })),
      },
      {
        ...original,
        holds: original.holds.map((hold, index) => index === 0
          ? { ...hold, id: "10000000-0000-4000-8000-000000000203" }
          : hold),
      },
      {
        ...original,
        holds: original.holds.map((hold, index) => index === 0
          ? { ...hold, createdAt: new Date(hold.createdAt.getTime() - 1) }
          : hold),
      },
      {
        ...original,
        seats: original.seats.map((seat, index) => index === 0
          ? { ...seat, id: "10000000-0000-4000-8000-000000000303" }
          : seat),
      },
      {
        ...original,
        seats: original.seats.map((seat) => ({
          ...seat,
          slot: seat.slot === 1 ? 2 as const : 1 as const,
        })),
      },
      {
        ...original,
        seats: original.seats.map((seat) => seat.state === "active"
          ? { ...seat,
            membershipId: "10000000-0000-4000-8000-000000000403" }
          : seat),
      },
      {
        ...original,
        seats: original.seats.map((seat) => seat.state === "pending"
          ? { ...seat, expiresAt: new Date(seat.expiresAt!.getTime() + 1) }
          : seat),
      },
    ];

    for (const value of changed) {
      expect(canonicalEntitlementSnapshotHashV1(value)).not.toBe(baseline);
    }
  });

  it("rejects malformed duplicate and cross-account snapshots", () => {
    const original = snapshot();
    expect(() => canonicalEntitlementSnapshotHashV1({
      ...original,
      now: new Date(Number.NaN),
    })).toThrow("ENTITLEMENT_INPUT_INVALID");
    expect(() => canonicalEntitlementSnapshotHashV1({
      ...original,
      grants: [...original.grants, original.grants[0]!],
    })).toThrow("ENTITLEMENT_INPUT_INVALID");
    expect(() => canonicalEntitlementSnapshotHashV1({
      ...original,
      holds: original.holds.map((hold, index) => index === 0
        ? { ...hold, accountId: "20000000-0000-4000-8000-000000000002" }
        : hold),
    })).toThrow("ENTITLEMENT_INPUT_INVALID");
  });
});

describe("public Business OS reconciliation repository", () => {
  it("calls only the closed Task 8 extension and validates its exact result", async () => {
    const execute = vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      expect(new PgDialect().sqlToQuery(query).sql).toContain(
        "syntholo_record_public_business_os_setup_reconciliation",
      );
      return { rows: [{
        outcome: "applied",
        replayed: false,
        result: {
          reconciliationId: "10000000-0000-4000-8000-000000000502",
          receiptStatus: "paid_reconciliation",
          setupKind: "parked_receipt",
          sourceRegistryId: "10000000-0000-4000-8000-000000000501",
        },
      }] };
    });
    const repository = new TransactionEntitlementRepository(
      { execute } as never,
      {
        accountId,
        actor: { actorId: "commerce-fulfillment.v1", kind: "system" },
        clock: { now: () => new Date("2026-08-15T12:00:00.123Z") },
        correlationId: "10000000-0000-4000-8000-000000000503",
      },
      {
        assertActive: vi.fn(),
        assertSettled: vi.fn(),
        run: async (operation) => operation(),
      },
    );

    await expect(repository.recordPublicBusinessOsSetupReconciliation({
      commandId: "10000000-0000-4000-8000-000000000504",
      purchasedAt: new Date("2026-08-15T11:00:00.123Z"),
      reconciliationReason: "PAID_SEMANTIC_CONFLICT",
      sourceId: "pi_public_bos_paid",
    })).resolves.toMatchObject({
      status: "applied",
      value: {
        receiptStatus: "paid_reconciliation",
        setupKind: "parked_receipt",
      },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("freezes exactly four public reconciliation reasons", () => {
    expect(publicBusinessOsReconciliationReasons).toEqual([
      "STRIPE_CUSTOMER_OWNERSHIP_COLLISION",
      "PAID_CLAIM_IDENTITY_CONFLICT",
      "PAID_IDENTITY_STATE_STALE",
      "PAID_SEMANTIC_CONFLICT",
    ]);
  });
});
