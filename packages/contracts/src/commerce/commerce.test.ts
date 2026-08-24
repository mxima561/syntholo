import { describe, expect, it } from "vitest";
import {
  BusinessOsSubscriptionSelectionSchema,
  ClaimInitiateSelectionSchema,
  CheckoutPendingResponseSchema,
  COMMERCE_ERROR_CODES,
  MemberCheckoutSelectionSchema,
  NormalizedStripeCanonicalObjectSchema,
  OperatorClubQuoteSelectionSchema,
  OnboardingPatchSelectionSchema,
  PublicCheckoutSelectionSchema,
  SafeOfferProjectionSchema,
  StripeEventEnvelopeSchema,
  StripeMetadataSchema,
  SafeClaimPreviewSchema,
} from "./index";

describe("commerce wire contracts", () => {
  it("accepts a provider-free public offer projection and rejects provider authority", () => {
    const safe = {
      code: "self_paced",
      state: "enabled",
      purchaseModel: "one_time",
      displayPrice: { kind: "one_time", currency: "usd", unitAmount: 39_900 },
      availability: { state: "available" },
      catalogVersion: "catalog_2026_08_v1",
    };
    expect(SafeOfferProjectionSchema.parse(safe)).toEqual(safe);
    for (const forbidden of [
      { providerPriceId: "price_test" },
      { providerProductId: "prod_test" },
      { providerAccountId: "acct_test" },
      { customerId: "cus_test" },
    ]) {
      expect(SafeOfferProjectionSchema.safeParse({ ...safe, ...forbidden }).success).toBe(false);
    }
  });

  it("represents Business OS as two separate prices and rejects misleading paid projections", () => {
    const businessOs = {
      code: "business_os",
      state: "enabled",
      purchaseModel: "two_stage",
      displayPrice: {
        kind: "two_stage",
        currency: "usd",
        setupUnitAmount: 99_900,
        recurringUnitAmount: 19_900,
        recurringInterval: "month",
      },
      availability: { state: "available" },
      catalogVersion: "catalog_2026_08_v1",
    };
    expect(SafeOfferProjectionSchema.parse(businessOs)).toEqual(businessOs);
    expect(SafeOfferProjectionSchema.safeParse({ ...businessOs, displayPrice: null }).success).toBe(false);
    expect(SafeOfferProjectionSchema.safeParse({
      ...businessOs,
      purchaseModel: "one_time",
    }).success).toBe(false);
  });

  it("lets a public browser select only an offer and safe policy/attribution fields", () => {
    const selection = {
      offerCode: "self_paced",
      email: "owner@example.test",
      businessName: "Northstar Studio",
      attributionId: "01915eb4-207a-7000-8000-000000000001",
      acceptedPolicyVersions: {
        terms: "terms_2026_08",
        privacy: "privacy_2026_08",
        refund: "refund_2026_08",
      },
    };
    expect(PublicCheckoutSelectionSchema.parse(selection)).toEqual(selection);
    for (const forbidden of [
      { priceId: "price_test" },
      { amount: 1 },
      { currency: "usd" },
      { accountId: "01915eb4-207a-7000-8000-000000000002" },
      { customerId: "cus_test" },
      { automaticTax: true },
    ]) {
      expect(PublicCheckoutSelectionSchema.safeParse({ ...selection, ...forbidden }).success).toBe(false);
    }
  });

  it("keeps member and recurring selections strict and account-free", () => {
    expect(MemberCheckoutSelectionSchema.parse({ offerCode: "business_os" })).toEqual({
      offerCode: "business_os",
    });
    expect(MemberCheckoutSelectionSchema.safeParse({
      offerCode: "business_os",
      accountId: "01915eb4-207a-7000-8000-000000000002",
    }).success).toBe(false);
    expect(OperatorClubQuoteSelectionSchema.parse({ cadence: "annual" })).toEqual({ cadence: "annual" });
    expect(OperatorClubQuoteSelectionSchema.safeParse({ cadence: "annual", amount: 59_000 }).success).toBe(false);
    expect(BusinessOsSubscriptionSelectionSchema.parse({})).toEqual({});
    expect(BusinessOsSubscriptionSelectionSchema.safeParse({ customerId: "cus_test" }).success).toBe(false);
  });

  it("exposes only the safe pending state and rejects accidental identifiers", () => {
    const pending = {
      state: "claim_sent",
      offerCode: "self_paced",
      updatedAt: "2026-08-15T12:00:00.000Z",
    };
    expect(CheckoutPendingResponseSchema.parse(pending)).toEqual(pending);
    expect(CheckoutPendingResponseSchema.safeParse({ ...pending, accountId: "hidden" }).success).toBe(false);
    expect(CheckoutPendingResponseSchema.safeParse({ ...pending, providerSessionId: "hidden" }).success).toBe(false);
  });

  it("allows only opaque checkout metadata keys and values", () => {
    const metadata = {
      checkout_authorization_id: "01915eb4-207a-7000-8000-000000000003",
      offer_code: "guided_pilot",
      catalog_version: "catalog_2026_08_v1",
      pilot_authorization_id: "01915eb4-207a-7000-8000-000000000004",
      refund_policy_version: "refund_2026_08",
    };
    expect(StripeMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(StripeMetadataSchema.safeParse({ ...metadata, email: "owner@example.test" }).success).toBe(false);
    expect(StripeMetadataSchema.safeParse({ ...metadata, account_name: "Northstar" }).success).toBe(false);
    expect(StripeMetadataSchema.safeParse({ ...metadata, offer_code: "not-an-offer" }).success).toBe(false);
    expect(StripeMetadataSchema.safeParse({ ...metadata, offer_code: "self_paced" }).success).toBe(false);
    expect(StripeMetadataSchema.safeParse({ ...metadata, pilot_authorization_id: undefined }).success).toBe(false);
    expect(StripeMetadataSchema.safeParse({
      ...metadata, offer_code: "operator_club_monthly", pilot_authorization_id: undefined,
    }).success).toBe(false);
    expect(StripeMetadataSchema.safeParse({
      ...metadata, offer_code: "self_paced", pilot_authorization_id: undefined,
      recurring_policy_version: "forbidden",
    }).success).toBe(false);
  });

  it("normalizes a direct-account Stripe event without retaining provider payload", () => {
    const envelope = {
      eventId: "evt_test",
      eventType: "invoice.paid",
      knownEvent: true,
      objectTypeValid: true,
      livemode: false,
      apiVersion: "2026-06-24.dahlia",
      providerCreatedAt: "2026-08-15T12:00:00.000Z",
      dataObjectType: "invoice",
      dataObjectId: "in_test",
      receiverAccountId: "acct_test",
      eventAccount: null,
      eventContext: null,
      rawBodySha256: "a".repeat(64),
    };
    expect(StripeEventEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(StripeEventEnvelopeSchema.safeParse({ ...envelope, data: { object: { email: "hidden" } } }).success).toBe(false);
    expect(StripeEventEnvelopeSchema.safeParse({ ...envelope, rawBody: "hidden" }).success).toBe(false);
    expect(StripeEventEnvelopeSchema.safeParse({ ...envelope, knownEvent: false }).success).toBe(false);
    expect(StripeEventEnvelopeSchema.safeParse({ ...envelope, dataObjectType: "customer", objectTypeValid: true }).success).toBe(false);
    expect(StripeEventEnvelopeSchema.safeParse({
      ...envelope,
      apiVersion: "2026-03-25.dahlia",
    }).success).toBe(true);
  });

  it("strictly owns every normalized canonical Stripe object envelope", () => {
    const invoice = {
      kind: "invoice",
      providerInvoiceId: "in_test",
      livemode: false,
      status: "paid",
      paid: true,
      collectionMethod: "charge_automatically",
      currency: "usd",
      amountDue: 19_900,
      amountPaid: 19_900,
      amountRemaining: 0,
      totalTaxAmount: 0,
      providerCustomerId: "cus_test",
      subscriptionId: "sub_test",
      paymentReferences: [{
        kind: "payment_intent",
        providerPaymentId: "pi_test",
        status: "paid",
        amountPaid: 19_900,
        amountRequested: 19_900,
        currency: "usd",
        paidAt: "2026-04-15T16:00:00.000Z",
      }],
      metadata: {},
      lineItems: [{
        amount: 19_900,
        subtotal: 19_900,
        currency: "usd",
        providerPriceId: "price_test",
        quantity: 1,
        periodStart: "2026-04-15T16:00:00.000Z",
        periodEnd: "2026-05-16T16:00:00.000Z",
        taxes: [{ amount: 0, taxBehavior: "exclusive", taxabilityReason: "not_collecting", taxableAmount: 19_900 }],
      }],
    };
    expect(NormalizedStripeCanonicalObjectSchema.parse(invoice)).toEqual(invoice);
    expect(NormalizedStripeCanonicalObjectSchema.safeParse({ ...invoice, customerEmail: "hidden@example.test" }).success)
      .toBe(false);
  });

  it("keeps claim and onboarding primitives strict and provider-free", () => {
    expect(ClaimInitiateSelectionSchema.parse({ token: "a".repeat(43) })).toEqual({ token: "a".repeat(43) });
    expect(ClaimInitiateSelectionSchema.safeParse({ token: "a".repeat(43), accountId: "hidden" }).success).toBe(false);
    expect(SafeClaimPreviewSchema.parse({
      state: "ready",
      offerCode: "business_os",
      businessName: "Northstar Studio",
      expiresAt: "2026-08-22T12:00:00.000Z",
    })).toEqual({
      state: "ready",
      offerCode: "business_os",
      businessName: "Northstar Studio",
      expiresAt: "2026-08-22T12:00:00.000Z",
    });
    expect(OnboardingPatchSelectionSchema.parse({
      expectedVersion: 2,
      step: "business_profile",
      businessName: "Northstar Studio",
      timezone: "America/New_York",
    })).toEqual({
      expectedVersion: 2,
      step: "business_profile",
      businessName: "Northstar Studio",
      timezone: "America/New_York",
    });
    expect(OnboardingPatchSelectionSchema.safeParse({
      expectedVersion: 2,
      step: "business_profile",
      customerId: "cus_test",
    }).success).toBe(false);
    expect(OnboardingPatchSelectionSchema.safeParse({
      expectedVersion: 2,
      step: "business_profile",
      website: "javascript:alert(1)",
    }).success).toBe(false);
    expect(OnboardingPatchSelectionSchema.safeParse({
      expectedVersion: 2,
      step: "business_profile",
      timezone: "Not/A_Timezone",
    }).success).toBe(false);
  });

  it("exports the stable commerce errors used by future route and worker boundaries", () => {
    expect(COMMERCE_ERROR_CODES).toEqual([
      "OFFER_UNAVAILABLE",
      "CURRICULUM_GATE_BLOCKED",
      "BUSINESS_OS_NOT_READY",
      "ACADEMY_REQUIRED",
      "COMMERCE_HELD",
      "BUSINESS_OS_SETUP_EXISTS",
      "AUTHORIZATION_EXPIRED",
      "AUTHORIZATION_CONSUMED",
      "CATALOG_MISMATCH",
      "CHECKOUT_IN_PROGRESS",
      "PAYMENT_PENDING",
      "CLAIM_EMAIL_MISMATCH",
      "VERIFIED_EMAIL_REQUIRED",
      "CLAIM_EXPIRED",
      "CLAIM_CONSUMED",
      "SEAT_LIMIT_REACHED",
      "REFUND_WINDOW_EXPIRED",
      "PROVISIONING_ALREADY_STARTED",
      "DEPENDENCY_UNAVAILABLE",
    ]);
  });
});
