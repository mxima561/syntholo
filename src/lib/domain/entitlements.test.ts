import { describe, expect, it } from "vitest";
import { canAccess } from "./entitlements";
import type { Entitlement } from "./types";

const now = new Date("2026-08-11T12:00:00.000Z");

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

