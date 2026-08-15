import { describe, expect, it } from "vitest";
import {
  catalogBindingFingerprint,
  classifyPaidOfferEvent,
  evaluateOfferAvailability,
  reduceBusinessOsPurchase,
  validateCatalogBundle,
} from "./index.js";

const catalog = [
  { offerCode: "self_paced", role: "self_paced_once", unitAmount: 39_900, interval: null },
  { offerCode: "guided_pilot", role: "guided_pilot_once", unitAmount: 75_000, interval: null },
  { offerCode: "operator_club_monthly", role: "operator_club_monthly", unitAmount: 5_900, interval: "month" },
  { offerCode: "operator_club_annual", role: "operator_club_annual", unitAmount: 59_000, interval: "year" },
  { offerCode: "business_os", role: "business_os_setup", unitAmount: 99_900, interval: null },
  { offerCode: "business_os", role: "business_os_monthly", unitAmount: 19_900, interval: "month" },
].map((binding) => ({
  ...binding,
  currency: "usd" as const,
  intervalCount: binding.interval === null ? null : 1,
  productTaxCode: "txcd_test",
  taxBehavior: "exclusive" as const,
}));

const fingerprintBinding = {
  active: true,
  catalogVersion: "2026-08-v1",
  currency: "usd" as const,
  environment: "test" as const,
  interval: null,
  intervalCount: null,
  livemode: false,
  offerCode: "self_paced" as const,
  productId: "prod_test",
  productTaxCode: "txcd_test",
  providerAccountId: "acct_test",
  providerPriceId: "price_test",
  role: "self_paced_once",
  taxBehavior: "exclusive" as const,
  unitAmount: 39_900,
  validFrom: "2026-08-15T00:00:00.000Z",
  validUntil: null,
};

describe("commerce catalog and availability", () => {
  it("accepts exactly the six ordinary bindings with integer USD minor units", () => {
    expect(validateCatalogBundle(catalog)).toEqual({ ok: true });
    expect(validateCatalogBundle(catalog.map((binding, index) => index === 0
      ? { ...binding, unitAmount: 399.5 }
      : binding))).toEqual({ ok: false, reason: "INVALID_MONEY" });
    expect(validateCatalogBundle(catalog.slice(0, -1))).toEqual({
      ok: false,
      reason: "REQUIRED_BINDING_MISSING",
    });
    expect(validateCatalogBundle([...catalog, catalog[0]!])).toEqual({
      ok: false,
      reason: "DUPLICATE_BINDING",
    });
    expect(validateCatalogBundle(catalog.map((binding, index) => index === 0
      ? { ...binding, unitAmount: 40_000 }
      : binding))).toEqual({ ok: false, reason: "INVALID_BINDING" });
    expect(validateCatalogBundle(catalog.map((binding, index) => index === 2
      ? { ...binding, interval: "year" }
      : binding))).toEqual({ ok: false, reason: "INVALID_BINDING" });
    expect(validateCatalogBundle(catalog.map((binding, index) => index === 0
      ? { ...binding, role: "wrong_role" }
      : binding))).toEqual({ ok: false, reason: "REQUIRED_BINDING_MISSING" });
    expect(validateCatalogBundle(catalog.map((binding, index) => index === 0
      ? { ...binding, productTaxCode: "" }
      : binding))).toEqual({ ok: false, reason: "INVALID_BINDING" });
    expect(validateCatalogBundle(catalog.map((binding, index) => index === 0
      ? { ...binding, productTaxCode: "garbage" }
      : binding))).toEqual({ ok: false, reason: "INVALID_BINDING" });
  });

  it("produces a deterministic canonical SHA-256 price-binding fingerprint", () => {
    expect(catalogBindingFingerprint(fingerprintBinding))
      .toBe("96cd5100a012d0c8369b5d9b6703b59f27fd0abd463345c12f257918f2ec6e96");
  });

  it("rejects malformed or semantically incoherent fingerprint inputs before canonicalization", () => {
    for (const override of [
      { unitAmount: Number.NaN },
      { unitAmount: Number.POSITIVE_INFINITY },
      { unitAmount: -1 },
      { interval: "year", intervalCount: 1 },
      { offerCode: "unknown" },
      { role: "operator_club_monthly" },
      { environment: "unknown" },
      { productId: "" },
      { productTaxCode: "" },
      { providerAccountId: "not_an_account" },
      { providerPriceId: "not_a_price" },
      { validFrom: "2026-08-15" },
      { validUntil: "2026-08-14T00:00:00.000Z" },
    ]) {
      expect(() => catalogBindingFingerprint({ ...fingerprintBinding, ...override } as never))
        .toThrowError(new Error("CATALOG_BINDING_INVALID"));
    }
  });

  it("fails closed on offer state and each offer-specific gate", () => {
    const base = {
      offerState: "enabled" as const,
      commerceHeld: false,
      catalogAttested: true,
      contentReady: true,
      pilotAuthorized: true,
      academyEligible: true,
      businessOsReady: true,
    };
    expect(evaluateOfferAvailability({ ...base, offerCode: "self_paced" })).toEqual({ state: "available" });
    expect(evaluateOfferAvailability({ ...base, offerCode: "self_paced", contentReady: false })).toEqual({
      state: "unavailable", reason: "CURRICULUM_GATE_BLOCKED",
    });
    expect(evaluateOfferAvailability({ ...base, offerCode: "guided_pilot", pilotAuthorized: false })).toEqual({
      state: "unavailable", reason: "AUTHORIZATION_EXPIRED",
    });
    expect(evaluateOfferAvailability({ ...base, offerCode: "operator_club_monthly", academyEligible: false })).toEqual({
      state: "unavailable", reason: "ACADEMY_REQUIRED",
    });
    expect(evaluateOfferAvailability({ ...base, offerCode: "business_os", businessOsReady: false })).toEqual({
      state: "unavailable", reason: "BUSINESS_OS_NOT_READY",
    });
    expect(evaluateOfferAvailability({ ...base, offerCode: "business_os", commerceHeld: true })).toEqual({
      state: "unavailable", reason: "COMMERCE_HELD",
    });
    expect(evaluateOfferAvailability({ ...base, offerCode: "self_paced", catalogAttested: false })).toEqual({
      state: "unavailable", reason: "CATALOG_MISMATCH",
    });
    expect(evaluateOfferAvailability({
      ...base, offerCode: "scorecard", catalogAttested: false, commerceHeld: true,
    })).toEqual({ state: "available" });
    expect(evaluateOfferAvailability({ ...base, offerCode: "made_up" as never })).toEqual({
      state: "unavailable", reason: "OFFER_UNAVAILABLE",
    });
  });
});

describe("two-stage Business OS reducer", () => {
  it("records setup as a zero-grant purchase and requires a separate subscription", () => {
    expect(reduceBusinessOsPurchase({ projection: "none" }, {
      type: "setup_payment_paid",
      sourceId: "pi_setup_test",
      paidAt: new Date("2026-08-15T12:00:00.000Z"),
    })).toEqual({
      projection: "setup_paid_subscription_required",
      setupSourceId: "pi_setup_test",
      command: {
        kind: "record_business_os_setup_purchase",
        sourceId: "pi_setup_test",
        purchasedAt: "2026-08-15T12:00:00.000Z",
      },
    });
  });

  it("rejects recurring payment without setup and activates only from the recurring subscription source", () => {
    expect(() => reduceBusinessOsPurchase({ projection: "none" }, {
      type: "recurring_invoice_paid",
      lifecycle: "initial",
      sourceId: "sub_test",
      occurredAt: new Date("2026-08-15T12:00:00.000Z"),
      paidThroughAt: new Date("2026-09-15T12:00:00.000Z"),
    })).toThrowError(new Error("BUSINESS_OS_SETUP_REQUIRED"));

    expect(reduceBusinessOsPurchase({
      projection: "setup_paid_subscription_required",
      setupSourceId: "pi_setup_test",
    }, {
      type: "recurring_invoice_paid",
      lifecycle: "initial",
      sourceId: "sub_test",
      occurredAt: new Date("2026-08-15T12:00:00.000Z"),
      paidThroughAt: new Date("2026-09-15T12:00:00.000Z"),
    })).toEqual({
      projection: "subscription_paid",
      setupSourceId: "pi_setup_test",
      subscriptionSourceId: "sub_test",
      paidThroughAt: "2026-09-15T12:00:00.000Z",
      command: {
        kind: "fulfill_product",
        sourceKind: "subscription",
        sourceId: "sub_test",
        offerCode: "business_os",
        startsAt: "2026-08-15T12:00:00.000Z",
        endsAt: "2026-09-15T12:00:00.000Z",
      },
    });
  });

  it("uses exact UTC milliseconds and does not reactivate a terminal subscription source", () => {
    expect(() => reduceBusinessOsPurchase({
      projection: "subscription_terminal",
      setupSourceId: "pi_setup_test",
      subscriptionSourceId: "sub_test",
    }, {
      type: "recurring_invoice_paid",
      lifecycle: "recovery",
      sourceRegistryId: "01915eb4-207a-7000-8000-000000000020",
      sourceId: "sub_test",
      paidThroughAt: new Date("2026-09-15T12:00:00.000Z"),
    })).toThrowError(new Error("BUSINESS_OS_SOURCE_TERMINAL"));
    expect(() => reduceBusinessOsPurchase({ projection: "none" }, {
      type: "unknown_event",
      sourceId: "sub_test",
      paidThroughAt: new Date("2026-09-15T12:00:00.000Z"),
    } as never)).toThrowError(new Error("BUSINESS_OS_EVENT_INVALID"));
    expect(() => reduceBusinessOsPurchase({
      projection: "subscription_paid", setupSourceId: "pi_setup_test",
      subscriptionSourceId: "sub_test", paidThroughAt: "2026-09-15T12:00:00.000Z",
    }, {
      type: "recurring_invoice_paid", lifecycle: "bogus", sourceId: "sub_test",
      sourceRegistryId: "01915eb4-207a-7000-8000-000000000022",
      paidThroughAt: new Date("2026-10-15T12:00:00.000Z"),
    } as never)).toThrowError(new Error("BUSINESS_OS_EVENT_INVALID"));
    expect(() => reduceBusinessOsPurchase({ projection: "none" }, {
      type: "setup_payment_paid",
      sourceId: "pi_setup_test",
      paidAt: new Date("invalid"),
    })).toThrowError(new Error("COMMERCE_TIME_INVALID"));
    expect(() => reduceBusinessOsPurchase({
      projection: "setup_paid_subscription_required", setupSourceId: "pi_setup_test",
    }, {
      type: "recurring_invoice_paid", lifecycle: "initial", sourceId: "sub_test",
      occurredAt: new Date("2026-09-15T12:00:00.000Z"),
      paidThroughAt: new Date("2026-09-15T12:00:00.000Z"),
    })).toThrowError(new Error("COMMERCE_INTERVAL_INVALID"));
    expect(() => reduceBusinessOsPurchase({
      projection: "subscription_paid", setupSourceId: "pi_setup_test",
      subscriptionSourceId: "sub_test", paidThroughAt: "2026-09-15T12:00:00.000Z",
    }, {
      type: "recurring_invoice_paid", lifecycle: "renewal", sourceId: "sub_test",
      sourceRegistryId: "01915eb4-207a-7000-8000-000000000033",
      paidThroughAt: new Date("2026-09-14T12:00:00.000Z"),
    })).toThrowError(new Error("COMMERCE_INTERVAL_INVALID"));
  });
});

describe("ordinary paid-event classifier", () => {
  it("returns only bounded Task 8 command intent with the accepted source semantics", () => {
    expect(classifyPaidOfferEvent({
      offerCode: "self_paced",
      lifecycle: "initial",
      sourceId: "pi_academy_test",
      occurredAt: new Date("2026-08-15T12:00:00.000Z"),
    })).toEqual({
      kind: "fulfill_product",
      offerCode: "self_paced",
      sourceKind: "purchase",
      sourceId: "pi_academy_test",
      startsAt: "2026-08-15T12:00:00.000Z",
    });
    expect(classifyPaidOfferEvent({
      offerCode: "operator_club_annual",
      lifecycle: "initial",
      sourceId: "sub_club_test",
      academySourceRegistryId: "01915eb4-207a-7000-8000-000000000030",
      occurredAt: new Date("2026-08-15T12:00:00.000Z"),
      paidThroughAt: new Date("2027-08-15T12:00:00.000Z"),
    })).toEqual({
      kind: "fulfill_product",
      offerCode: "operator_club_annual",
      sourceKind: "subscription",
      sourceId: "sub_club_test",
      academySourceRegistryId: "01915eb4-207a-7000-8000-000000000030",
      startsAt: "2026-08-15T12:00:00.000Z",
      endsAt: "2027-08-15T12:00:00.000Z",
    });
    expect(() => classifyPaidOfferEvent({
      offerCode: "scorecard" as never,
      lifecycle: "initial",
      sourceId: "source_test",
      occurredAt: new Date("2026-08-15T12:00:00.000Z"),
    })).toThrowError(new Error("COMMERCE_OFFER_NOT_PAID"));
    expect(() => classifyPaidOfferEvent({
      offerCode: "business_os" as never,
      lifecycle: "initial",
      sourceId: "source_test",
      occurredAt: new Date("2026-08-15T12:00:00.000Z"),
    })).toThrowError(new Error("BUSINESS_OS_STAGE_REQUIRED"));
    expect(classifyPaidOfferEvent({
      offerCode: "operator_club_monthly",
      lifecycle: "renewal",
      sourceId: "sub_club_test",
      sourceRegistryId: "01915eb4-207a-7000-8000-000000000021",
      academySourceRegistryId: "01915eb4-207a-7000-8000-000000000031",
      occurredAt: new Date("2026-09-15T12:00:00.000Z"),
      paidThroughAt: new Date("2026-10-15T12:00:00.000Z"),
    })).toEqual({
      kind: "recover_club_payment",
      lifecycle: "renewal",
      sourceRegistryId: "01915eb4-207a-7000-8000-000000000021",
      paidThroughAt: "2026-10-15T12:00:00.000Z",
    });
    expect(() => classifyPaidOfferEvent({
      offerCode: "made_up_offer",
      lifecycle: "initial",
      sourceId: "source_test",
      occurredAt: new Date("2026-08-15T12:00:00.000Z"),
    } as never)).toThrowError(new Error("COMMERCE_OFFER_INVALID"));
    expect(() => classifyPaidOfferEvent({
      offerCode: "operator_club_monthly", lifecycle: "bogus", sourceId: "sub_club_test",
      sourceRegistryId: "01915eb4-207a-7000-8000-000000000023",
      academySourceRegistryId: "01915eb4-207a-7000-8000-000000000032",
      occurredAt: new Date("2026-09-15T12:00:00.000Z"),
      paidThroughAt: new Date("2026-10-15T12:00:00.000Z"),
    } as never)).toThrowError(new Error("COMMERCE_LIFECYCLE_INVALID"));
    expect(() => classifyPaidOfferEvent({
      offerCode: "operator_club_monthly", lifecycle: "initial", sourceId: "sub_club_test",
      academySourceRegistryId: "01915eb4-207a-7000-8000-000000000034",
      occurredAt: new Date("2026-10-15T12:00:00.000Z"),
      paidThroughAt: new Date("2026-10-15T12:00:00.000Z"),
    })).toThrowError(new Error("COMMERCE_INTERVAL_INVALID"));
  });
});
