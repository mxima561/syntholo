import { describe, expect, it } from "vitest";
import { evaluateEntitlements } from "../entitlements";
import type { ContentLaunchReadiness } from "../content/readiness";
import { evaluateOfferAvailability, guestAccess, type OfferContext } from "./availability";
import { capabilitiesCreatedBy, offersByCode, type Offer } from "./offers";

const evaluatedAt = new Date("2026-08-25T12:00:00.000Z");

function blockedContent(overrides: Partial<ContentLaunchReadiness> = {}): ContentLaunchReadiness {
  return {
    requiredLessons: 18,
    readyLessons: 18,
    contentHash: "hash",
    automatedPassedAt: "2026-08-01T00:00:00.000Z",
    humanApprovedAt: null,
    canSellAcademy: false,
    ...overrides,
  };
}

function sellableContent(): ContentLaunchReadiness {
  return {
    requiredLessons: 18,
    readyLessons: 18,
    contentHash: "hash",
    automatedPassedAt: "2026-08-01T00:00:00.000Z",
    humanApprovedAt: "2026-08-02T00:00:00.000Z",
    canSellAcademy: true,
  };
}

function context(overrides: Partial<OfferContext> & { readyLessons?: number; humanApprovedAt?: string | null } = {}): OfferContext {
  const humanApprovedAt = Object.prototype.hasOwnProperty.call(overrides, "humanApprovedAt")
    ? overrides.humanApprovedAt ?? null
    : null;
  const content =
    overrides.content ??
    blockedContent({
      readyLessons: overrides.readyLessons ?? 18,
      humanApprovedAt,
      automatedPassedAt: (overrides.readyLessons ?? 18) === 18 ? "2026-08-01T00:00:00.000Z" : null,
      canSellAcademy: false,
    });
  return {
    content,
    access: overrides.access ?? guestAccess(),
    businessOsReady: overrides.businessOsReady ?? false,
  };
}

describe("evaluateOfferAvailability", () => {
  it("keeps the scorecard available before the curriculum gate", () => {
    expect(evaluateOfferAvailability(offersByCode.scorecard, context()).available).toBe(true);
  });

  it("blocks Academy payment until automated and human curriculum gates pass", () => {
    const blocked = evaluateOfferAvailability(offersByCode.self_paced, context({ readyLessons: 18, humanApprovedAt: null }));
    expect(blocked).toEqual({ available: false, reasonCode: "CURRICULUM_GATE_BLOCKED", startsAt: null });
  });

  it("blocks Guided Pilot with the same curriculum gate", () => {
    expect(evaluateOfferAvailability(offersByCode.guided_pilot, context()).reasonCode).toBe("CURRICULUM_GATE_BLOCKED");
  });

  it("does not make Business OS imply Academy access", () => {
    expect(capabilitiesCreatedBy("business_os")).toEqual(["business_os"]);
  });

  it("does not grant Academy from Operator Club", () => {
    expect(capabilitiesCreatedBy("operator_club_monthly")).not.toContain("academy_course");
  });

  it("requires Academy access before Operator Club", () => {
    expect(evaluateOfferAvailability(offersByCode.operator_club_monthly, context({ content: sellableContent() })).reasonCode).toBe(
      "ACADEMY_REQUIRED",
    );
  });

  it("blocks Business OS until operational readiness is attached", () => {
    expect(evaluateOfferAvailability(offersByCode.business_os, context({ businessOsReady: false })).reasonCode).toBe(
      "BUSINESS_OS_NOT_READY",
    );
  });

  it("returns OFFER_DISABLED when the catalog state is not enabled", () => {
    const draft: Offer = { ...offersByCode.self_paced, state: "paused" };
    expect(evaluateOfferAvailability(draft, context({ content: sellableContent() }))).toEqual({
      available: false,
      reasonCode: "OFFER_DISABLED",
      startsAt: null,
    });
  });

  it("blocks purchases while a commerce hold is active", () => {
    const access = evaluateEntitlements({
      accountId: "acct-1",
      now: evaluatedAt,
      grants: [],
      holds: [{ kind: "commerce", active: true }],
      seats: [],
    });
    expect(evaluateOfferAvailability(offersByCode.business_os, context({ access, businessOsReady: true })).reasonCode).toBe(
      "COMMERCE_HOLD",
    );
  });

  it("allows Self-Paced after both curriculum gates pass", () => {
    expect(evaluateOfferAvailability(offersByCode.self_paced, context({ content: sellableContent() }))).toEqual({
      available: true,
      reasonCode: null,
      startsAt: null,
    });
  });

  it("allows Operator Club only with an effective Academy grant", () => {
    const access = evaluateEntitlements({
      accountId: "acct-1",
      now: evaluatedAt,
      grants: [{ id: "g1", capability: "academy_course", status: "active", startsAt: evaluatedAt, endsAt: null }],
      holds: [],
      seats: [],
    });
    expect(
      evaluateOfferAvailability(offersByCode.operator_club_monthly, context({ content: sellableContent(), access })).available,
    ).toBe(true);
  });
});
