import { describe, expect, it } from "vitest";
import { evaluateEntitlements } from "../entitlements";
import { assertCheckoutAuthorized } from "./authorize";
import { academyCurriculumOverrideEnabled, CheckoutAuthorizationError } from "./checkout";
import { guestAccess, type OfferContext } from "./availability";
import { offersByCode } from "./offers";
import type { ContentLaunchReadiness } from "../content/readiness";

const now = new Date("2026-08-25T12:00:00.000Z");

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

function blockedContent(): ContentLaunchReadiness {
  return { ...sellableContent(), humanApprovedAt: null, canSellAcademy: false };
}

function context(overrides: Partial<OfferContext> = {}): OfferContext {
  return {
    content: blockedContent(),
    access: guestAccess(),
    businessOsReady: false,
    ...overrides,
  };
}

describe("assertCheckoutAuthorized", () => {
  it("blocks Academy checkout until the curriculum gate passes", () => {
    expect(() =>
      assertCheckoutAuthorized({ offer: offersByCode.self_paced, context: context(), now }),
    ).toThrow(expect.objectContaining({ code: "CURRICULUM_GATE_BLOCKED" }));
  });

  it("ignores a canSellAcademy flag that is not backed by both gate timestamps", () => {
    expect(() =>
      assertCheckoutAuthorized({
        offer: offersByCode.self_paced,
        context: context({
          content: { ...blockedContent(), canSellAcademy: true, humanApprovedAt: null },
        }),
        now,
      }),
    ).toThrow(expect.objectContaining({ code: "CURRICULUM_GATE_BLOCKED" }));
  });

  it("does not honor a staging override in production", () => {
    expect(academyCurriculumOverrideEnabled({ NODE_ENV: "production", ACADEMY_CHECKOUT_STAGING_OVERRIDE: "1" })).toBe(false);
    expect(academyCurriculumOverrideEnabled({ APP_MODE: "production", ACADEMY_CHECKOUT_STAGING_OVERRIDE: "1" })).toBe(false);
    expect(() =>
      assertCheckoutAuthorized({
        offer: offersByCode.self_paced,
        context: context(),
        env: { NODE_ENV: "production", ACADEMY_CHECKOUT_STAGING_OVERRIDE: "1" },
        now,
      }),
    ).toThrow(CheckoutAuthorizationError);
  });

  it("allows a staging curriculum override only outside production", () => {
    expect(() =>
      assertCheckoutAuthorized({
        offer: offersByCode.self_paced,
        context: context(),
        env: { NODE_ENV: "test", ACADEMY_CHECKOUT_STAGING_OVERRIDE: "1" },
        now,
      }),
    ).not.toThrow();
  });

  it("blocks expired Pilot authorization after the curriculum gate passes", () => {
    expect(() =>
      assertCheckoutAuthorized({
        offer: offersByCode.guided_pilot,
        context: context({ content: sellableContent() }),
        now,
        pilotAuthorization: { status: "expired", offerCode: "guided_pilot", expiresAt: new Date("2026-08-01T00:00:00.000Z") },
      }),
    ).toThrow(expect.objectContaining({ code: "AUTHORIZATION_EXPIRED" }));
  });

  it("blocks Business OS when operational readiness is missing", () => {
    expect(() =>
      assertCheckoutAuthorized({
        offer: offersByCode.business_os,
        context: context({ businessOsReady: false }),
        now,
      }),
    ).toThrow(expect.objectContaining({ code: "BUSINESS_OS_NOT_READY" }));
  });

  it("blocks Operator Club without Academy access", () => {
    expect(() =>
      assertCheckoutAuthorized({
        offer: offersByCode.operator_club_monthly,
        context: context({ content: sellableContent() }),
        now,
      }),
    ).toThrow(expect.objectContaining({ code: "ACADEMY_REQUIRED" }));
  });

  it("authorizes Self-Paced when both curriculum gates pass", () => {
    expect(() =>
      assertCheckoutAuthorized({
        offer: offersByCode.self_paced,
        context: context({ content: sellableContent() }),
        now,
      }),
    ).not.toThrow();
  });

  it("authorizes Operator Club for an Academy member", () => {
    const access = evaluateEntitlements({
      accountId: "acct-1",
      now,
      grants: [{ id: "g1", capability: "academy_course", status: "active", startsAt: now, endsAt: null }],
      holds: [],
      seats: [],
    });
    expect(() =>
      assertCheckoutAuthorized({
        offer: offersByCode.operator_club_monthly,
        context: context({ content: sellableContent(), access }),
        now,
      }),
    ).not.toThrow();
  });
});
