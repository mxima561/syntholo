import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STRIPE_API_VERSION,
  StripeAdapterError,
  createStripeAdapter,
  createStripeReadAdapter,
  createStripeAdapterWithClient,
  verifyAndNormalizeStripeWebhook,
  type StripeClientPort,
} from "./stripe.js";

const checkoutResult = {
  id: "cs_test",
  object: "checkout.session",
  url: "https://checkout.stripe.com/c/pay/cs_test",
  expires_at: 1_776_427_200,
};

function fakeClient(overrides: Partial<StripeClientPort> = {}) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown[], result: unknown) => {
    (calls[name] ??= []).push(args);
    return Promise.resolve(result);
  };
  const value: StripeClientPort = {
    checkoutSessionsCreate: (params, options) => record("checkoutCreate", [params, options], checkoutResult),
    checkoutSessionsRetrieve: (id, params) => record("checkoutRetrieve", [id, params], {
      id: "cs_test", object: "checkout.session", livemode: false, mode: "payment",
      status: "complete", payment_status: "paid", customer: "cus_test",
      payment_intent: "pi_test", subscription: null, setup_intent: null,
      expires_at: 1_776_427_200, metadata: {},
      line_items: { data: [{ price: { id: "price_test" }, quantity: 1 }], has_more: false },
    }),
    setupIntentsRetrieve: (id, params) => record("setupIntentRetrieve", [id, params], {
      id: "seti_test", object: "setup_intent", livemode: false, status: "succeeded",
      customer: "cus_test", payment_method: {
        id: "pm_test", object: "payment_method", customer: "cus_test", type: "card",
      }, metadata: {},
    }),
    invoicesRetrieve: (id, params) => record("invoiceRetrieve", [id, params], {
      id: "in_test", object: "invoice", livemode: false, status: "paid", paid: true,
      collection_method: "charge_automatically", currency: "usd", amount_due: 19_900,
      amount_paid: 19_900, amount_remaining: 0, customer: "cus_test", metadata: {},
      parent: { type: "subscription_details", quote_details: null,
        subscription_details: { subscription: "sub_test", metadata: {} } },
      payments: { data: [{ id: "inpay_test", object: "invoice_payment", status: "paid", amount_paid: 19_900,
        amount_requested: 19_900, currency: "usd", invoice: "in_test", is_default: true, livemode: false,
        status_transitions: { canceled_at: null, paid_at: 1_776_424_370 },
        payment: { type: "payment_intent", payment_intent: "pi_invoice_test" } }], has_more: false },
      lines: { data: [{ id: "il_test", object: "line_item", amount: 19_900, subtotal: 19_900, currency: "usd",
        period: { start: 1_776_355_200, end: 1_779_033_600 }, quantity: 1,
        pricing: { type: "price_details", price_details: { price: "price_test", product: "prod_test" },
          unit_amount_decimal: "19900" }, taxes: [{ amount: 0, tax_behavior: "exclusive",
          taxability_reason: "not_collecting", taxable_amount: 19_900, type: "tax_rate_details",
          tax_rate_details: null }] }], has_more: false },
    }),
    subscriptionsRetrieve: (id, params) => record("subscriptionRetrieve", [id, params], {
      id: "sub_test", object: "subscription", livemode: false, status: "active",
      customer: "cus_test", cancel_at_period_end: false, canceled_at: null,
      metadata: {}, items: { data: [{ id: "si_test", object: "subscription_item",
        current_period_start: 1_776_355_200, current_period_end: 1_779_033_600,
        price: { id: "price_test" }, quantity: 1 }], has_more: false },
    }),
    subscriptionSchedulesRetrieve: (id) => record("scheduleRetrieve", [id], {
      id: "sub_sched_test", object: "subscription_schedule", livemode: false,
      status: "active", customer: "cus_test", subscription: "sub_test",
      metadata: {}, phases: [{ start_date: 1_779_033_600, end_date: 1_781_712_000,
        items: [{ price: "price_test", quantity: 1 }] }],
    }),
    refundsRetrieve: (id) => record("refundRetrieve", [id], {
      id: "re_test", object: "refund", status: "succeeded", amount: 39_900,
      currency: "usd", payment_intent: "pi_test", charge: "ch_test", metadata: {},
    }),
    paymentIntentsRetrieve: (id) => record("paymentIntentRetrieve", [id], {
      id: "pi_test", object: "payment_intent", livemode: false, status: "succeeded",
      amount: 39_900, amount_received: 39_900, currency: "usd", customer: "cus_test",
      latest_charge: "ch_test", metadata: {},
    }),
    chargesRetrieve: (id) => record("chargeRetrieve", [id], {
      id: "ch_test", object: "charge", livemode: false, paid: true, refunded: false,
      disputed: false, amount: 39_900, amount_refunded: 0, currency: "usd",
      customer: "cus_test", payment_intent: "pi_test", invoice: null,
    }),
    disputesRetrieve: (id) => record("disputeRetrieve", [id], {
      id: "dp_test", object: "dispute", livemode: false, status: "warning_needs_response",
      amount: 39_900, currency: "usd", charge: "ch_test", payment_intent: "pi_test",
    }),
    billingPortalSessionsCreate: (params, options) => record("portalCreate", [params, options], {
      id: "bps_test", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/test",
    }),
    ...overrides,
  };
  return { value, calls };
}

const metadata = {
  checkout_authorization_id: "01915eb4-207a-7000-8000-000000000001",
  offer_code: "self_paced" as const,
  catalog_version: "catalog_2026_08_v1",
  refund_policy_version: "refund_2026_08",
};

const common = {
  integrationIdentifier: "syntholo_abcdefgh",
  metadata,
  taxPolicy: { kind: "disabled" as const },
};
const oneTimeCommon = { ...common, invoicePolicy: "receipt_only" as const };

const adapterConfig = {
  checkoutSuccessUrl: "https://app.syntholo.com/claim",
  checkoutCancelUrl: "https://app.syntholo.com/pricing",
  portalConfigurationId: "bpc_test",
  portalReturnUrl: "https://app.syntholo.com/learn/settings/billing",
};

describe("Stripe hosted adapter", () => {
  it("pins the SDK API version and creates one-time Checkout with fixed quantity and dynamic methods", async () => {
    expect(STRIPE_API_VERSION).toBe("2026-06-24.dahlia");
    const fake = fakeClient();
    const adapter = createStripeAdapterWithClient(adapterConfig, fake.value);
    await expect(adapter.createCheckout({
      ...oneTimeCommon,
      kind: "one_time",
      providerPriceId: "price_test",
      providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000001",
      customerStrategy: "checkout",
    })).resolves.toEqual({
      providerSessionId: "cs_test",
      handoffUrl: "https://checkout.stripe.com/c/pay/cs_test",
      expiresAt: "2026-04-17T12:00:00.000Z",
    });
    expect(fake.calls.checkoutCreate).toEqual([[{
      mode: "payment",
      line_items: [{ price: "price_test", quantity: 1 }],
      success_url: adapterConfig.checkoutSuccessUrl,
      cancel_url: adapterConfig.checkoutCancelUrl,
      automatic_tax: { enabled: false },
      metadata,
      payment_intent_data: { metadata },
      integration_identifier: common.integrationIdentifier,
    }, { idempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000001" }]]);
    expect(JSON.stringify(fake.calls)).not.toContain("payment_method_types");
    expect(JSON.stringify(fake.calls)).not.toContain("invoice_creation");
  });

  it("creates a formal one-time invoice only from the server-owned catalog policy", async () => {
    const fake = fakeClient();
    const adapter = createStripeAdapterWithClient(adapterConfig, fake.value);
    await adapter.createCheckout({
      ...oneTimeCommon, kind: "one_time", invoicePolicy: "formal_invoice", providerPriceId: "price_test",
      providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000025", customerStrategy: "checkout",
    });
    expect(fake.calls.checkoutCreate).toEqual([[{
      mode: "payment", line_items: [{ price: "price_test", quantity: 1 }],
      success_url: adapterConfig.checkoutSuccessUrl, cancel_url: adapterConfig.checkoutCancelUrl,
      automatic_tax: { enabled: false }, metadata, payment_intent_data: { metadata },
      integration_identifier: common.integrationIdentifier, invoice_creation: { enabled: true },
    }, { idempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000025" }]]);
  });

  it("snapshots public and existing-account Business OS setup separately from recurring", async () => {
    const fake = fakeClient();
    const adapter = createStripeAdapterWithClient(adapterConfig, fake.value);
    const bosMetadata = { ...metadata, offer_code: "business_os" as const };
    const setupKey = "business_os_setup_checkout:01915eb4-207a-7000-8000-000000000002";
    await adapter.createCheckout({
      ...common, kind: "business_os_setup", providerPriceId: "price_bos_setup_test",
      providerIdempotencyKey: setupKey, customerStrategy: "create", metadata: bosMetadata,
    });
    await adapter.createCheckout({
      ...common, kind: "business_os_setup", providerPriceId: "price_bos_setup_test",
      providerIdempotencyKey: "business_os_setup_checkout:01915eb4-207a-7000-8000-000000000003",
      customerStrategy: "existing", providerCustomerId: "cus_test", metadata: bosMetadata,
    });
    await adapter.createCheckout({
      ...common, kind: "business_os_recurring", providerPriceId: "price_bos_monthly_test",
      providerIdempotencyKey: "business_os_recurring_checkout:01915eb4-207a-7000-8000-000000000004",
      customerStrategy: "existing", providerCustomerId: "cus_test",
      metadata: { ...bosMetadata, recurring_policy_version: "bos_recurring_2026_08" },
    });
    expect(fake.calls.checkoutCreate).toEqual([
      [{ mode: "payment", success_url: adapterConfig.checkoutSuccessUrl, cancel_url: adapterConfig.checkoutCancelUrl,
        metadata: bosMetadata, integration_identifier: common.integrationIdentifier,
        customer_creation: "always", line_items: [{ price: "price_bos_setup_test", quantity: 1 }],
        automatic_tax: { enabled: false },
        payment_intent_data: { metadata: bosMetadata, setup_future_usage: "off_session" } },
      { idempotencyKey: setupKey }],
      [{ mode: "payment", success_url: adapterConfig.checkoutSuccessUrl, cancel_url: adapterConfig.checkoutCancelUrl,
        metadata: bosMetadata, integration_identifier: common.integrationIdentifier,
        customer: "cus_test", line_items: [{ price: "price_bos_setup_test", quantity: 1 }],
        automatic_tax: { enabled: false },
        payment_intent_data: { metadata: bosMetadata, setup_future_usage: "off_session" } },
      { idempotencyKey: "business_os_setup_checkout:01915eb4-207a-7000-8000-000000000003" }],
      [{ mode: "subscription", success_url: adapterConfig.checkoutSuccessUrl, cancel_url: adapterConfig.checkoutCancelUrl,
        metadata: { ...bosMetadata, recurring_policy_version: "bos_recurring_2026_08" },
        integration_identifier: common.integrationIdentifier, customer: "cus_test",
        line_items: [{ price: "price_bos_monthly_test", quantity: 1 }], automatic_tax: { enabled: false },
        subscription_data: { metadata: { ...bosMetadata, recurring_policy_version: "bos_recurring_2026_08" } } },
      { idempotencyKey: "business_os_recurring_checkout:01915eb4-207a-7000-8000-000000000004" }],
    ]);
    expect(JSON.stringify(fake.calls.checkoutCreate)).not.toMatch(
      /payment_method_types|adjustable_quantity|allow_promotion_codes/u,
    );
    await expect(adapter.createCheckout({
      ...common, kind: "business_os_setup", providerPriceId: "price_bos_setup_test",
      providerIdempotencyKey: "checkout:wrong-prefix", customerStrategy: "create", metadata: bosMetadata,
    })).rejects.toEqual(expect.objectContaining({ code: "STRIPE_REQUEST_INVALID" }));
  });

  it("uses setup mode without a Price for early Club and subscription mode for immediate Club", async () => {
    const fake = fakeClient();
    const adapter = createStripeAdapterWithClient(adapterConfig, fake.value);
    const clubMetadata = {
      ...metadata, offer_code: "operator_club_monthly" as const,
      recurring_policy_version: "club_recurring_2026_08",
    };
    const setup = {
      ...common, kind: "operator_club_setup" as const,
      providerIdempotencyKey: "club_setup_checkout:01915eb4-207a-7000-8000-000000000005",
      customerStrategy: "existing" as const, providerCustomerId: "cus_test", metadata: clubMetadata,
    };
    await adapter.createCheckout(setup);
    await adapter.createCheckout({
      ...common, kind: "operator_club_subscription", providerPriceId: "price_club_test",
      providerIdempotencyKey: "club_subscription_checkout:01915eb4-207a-7000-8000-000000000006",
      customerStrategy: "existing", providerCustomerId: "cus_test", metadata: clubMetadata,
    });
    expect(fake.calls.checkoutCreate).toEqual([
      [{ mode: "setup", currency: "usd", success_url: adapterConfig.checkoutSuccessUrl, cancel_url: adapterConfig.checkoutCancelUrl,
        customer: "cus_test", metadata: clubMetadata, integration_identifier: common.integrationIdentifier,
        setup_intent_data: { metadata: clubMetadata } },
      { idempotencyKey: "club_setup_checkout:01915eb4-207a-7000-8000-000000000005" }],
      [{ mode: "subscription", success_url: adapterConfig.checkoutSuccessUrl, cancel_url: adapterConfig.checkoutCancelUrl,
        customer: "cus_test", metadata: clubMetadata, integration_identifier: common.integrationIdentifier,
        line_items: [{ price: "price_club_test", quantity: 1 }], automatic_tax: { enabled: false },
        subscription_data: { metadata: clubMetadata } },
      { idempotencyKey: "club_subscription_checkout:01915eb4-207a-7000-8000-000000000006" }],
    ]);
    expect(JSON.stringify(fake.calls.checkoutCreate?.[0])).not.toMatch(
      /line_items|payment_method_types|adjustable_quantity|allow_promotion_codes/u,
    );
    expect(JSON.stringify(fake.calls.checkoutCreate?.[1])).not.toMatch(
      /payment_method_types|adjustable_quantity|allow_promotion_codes/u,
    );
    await expect(adapter.createCheckout({ ...setup, providerPriceId: "price_forbidden" } as never))
      .rejects.toEqual(expect.objectContaining({ code: "STRIPE_REQUEST_INVALID" }));
  });

  it("enables automatic tax only from explicit registration/catalog/Product-tax-code attestation", async () => {
    const fake = fakeClient();
    const adapter = createStripeAdapterWithClient(adapterConfig, fake.value);
    await adapter.createCheckout({
      ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test",
      providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000007",
      customerStrategy: "checkout",
      taxPolicy: {
        kind: "approved", registrationAttestationId: "tax_attestation_2026_08",
        catalogAttestationId: "catalog_attestation_2026_08", productTaxCode: "txcd_test",
      },
    });
    expect(fake.calls.checkoutCreate?.[0]).toEqual([{
      mode: "payment", success_url: adapterConfig.checkoutSuccessUrl, cancel_url: adapterConfig.checkoutCancelUrl,
      metadata, integration_identifier: common.integrationIdentifier,
      line_items: [{ price: "price_test", quantity: 1 }], automatic_tax: { enabled: true },
      payment_intent_data: { metadata },
    }, { idempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000007" }]);
    await expect(adapter.createCheckout({
      ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test",
      providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000008",
      customerStrategy: "checkout", taxPolicy: { kind: "approved", productTaxCode: "" } as never,
    })).rejects.toEqual(expect.objectContaining({ code: "STRIPE_REQUEST_INVALID", retryable: false }));
    await expect(adapter.createCheckout({
      ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test",
      providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000024",
      customerStrategy: "checkout", taxPolicy: {
        kind: "approved", registrationAttestationId: "tax_attestation_2026_08",
        catalogAttestationId: "catalog_attestation_2026_08", productTaxCode: "garbage",
      },
    })).rejects.toEqual(expect.objectContaining({ code: "STRIPE_REQUEST_INVALID", retryable: false }));
  });

  it("uses only the server-owned Portal return URL and validates handoff origins", async () => {
    const fake = fakeClient();
    const adapter = createStripeAdapterWithClient(adapterConfig, fake.value);
    await expect(adapter.createBillingPortal({
      providerCustomerId: "cus_test",
      providerIdempotencyKey: "portal:01915eb4-207a-7000-8000-000000000009",
    })).resolves.toEqual({ providerSessionId: "bps_test", handoffUrl: "https://billing.stripe.com/p/session/test" });
    expect(fake.calls.portalCreate).toEqual([[{
      customer: "cus_test", configuration: "bpc_test",
      return_url: "https://app.syntholo.com/learn/settings/billing",
    }, { idempotencyKey: "portal:01915eb4-207a-7000-8000-000000000009" }]]);
    expect(() => createStripeAdapterWithClient({
      ...adapterConfig,
      checkoutSuccessUrl: "https://attacker.test/claim",
    }, fake.value)).toThrowError(expect.objectContaining({ code: "STRIPE_REQUEST_INVALID" }));
    expect(() => createStripeAdapterWithClient({
      ...adapterConfig,
      checkoutCancelUrl: "https://app.syntholo.com/pricing?redirect=https://attacker.test",
    }, fake.value)).toThrowError(expect.objectContaining({ code: "STRIPE_REQUEST_INVALID" }));
    await expect(adapter.createBillingPortal({
      providerCustomerId: "cus_test",
      providerIdempotencyKey: "portal:",
    })).rejects.toEqual(expect.objectContaining({ code: "STRIPE_REQUEST_INVALID" }));

    for (const result of [
      { id: "cs_test", object: "checkout.session", url: null, expires_at: 1_776_427_200 },
      { id: "cs_test", object: "checkout.session", url: "https://attacker.test/x", expires_at: 1_776_427_200 },
      { id: "cs_test", object: "checkout.session", url: "https://checkout.stripe.com:8443/x", expires_at: 1_776_427_200 },
      { id: "cs_test", object: "checkout.session", url: "https://user@checkout.stripe.com/x", expires_at: 1_776_427_200 },
    ]) {
      const invalid = fakeClient({ checkoutSessionsCreate: async () => result });
      await expect(createStripeAdapterWithClient(adapterConfig, invalid.value).createCheckout({
        ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test",
        providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000010",
        customerStrategy: "checkout",
      })).rejects.toEqual(expect.objectContaining({ code: "STRIPE_PROVIDER_SHAPE_INVALID" }));
    }
  });

  it("rejects checkout semantic mismatches and incomplete action idempotency keys", async () => {
    const adapter = createStripeAdapterWithClient(adapterConfig, fakeClient().value);
    for (const invalid of [
      { ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test", customerStrategy: "checkout",
        providerIdempotencyKey: "checkout:", metadata: common.metadata },
      { ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test", customerStrategy: "checkout",
        providerIdempotencyKey: "checkout:arbitrary", metadata: common.metadata },
      { ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test", customerStrategy: "checkout",
        providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000012",
        metadata: { ...common.metadata, offer_code: "business_os" } },
      { ...common, kind: "business_os_recurring", providerPriceId: "price_test", customerStrategy: "existing",
        providerCustomerId: "cus_test",
        providerIdempotencyKey: "business_os_recurring_checkout:01915eb4-207a-7000-8000-000000000013",
        metadata: { ...common.metadata, offer_code: "business_os" } },
      { ...common, kind: "business_os_setup", providerPriceId: "price_test", customerStrategy: "existing",
        providerCustomerId: "cus_test",
        providerIdempotencyKey: "business_os_setup_checkout:01915eb4-207a-7000-8000-000000000014",
        metadata: { ...common.metadata, offer_code: "business_os", recurring_policy_version: "unexpected" } },
      { ...common, kind: "operator_club_setup", customerStrategy: "checkout",
        providerCustomerId: "cus_test",
        providerIdempotencyKey: "club_setup_checkout:01915eb4-207a-7000-8000-000000000015",
        metadata: { ...common.metadata, offer_code: "operator_club_monthly", recurring_policy_version: "club_v1" } },
      { ...common, kind: "operator_club_setup", customerStrategy: "existing",
        providerCustomerId: "cus_test", taxPolicy: { kind: "disabled", extra: true },
        providerIdempotencyKey: "club_setup_checkout:01915eb4-207a-7000-8000-000000000016",
        metadata: { ...common.metadata, offer_code: "operator_club_monthly", recurring_policy_version: "club_v1" } },
      { ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test", customerStrategy: "checkout",
        providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000017",
        metadata: { ...common.metadata, pilot_authorization_id: "pilot_forbidden" } },
      { ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test", customerStrategy: "checkout",
        providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000018",
        metadata: { ...common.metadata, offer_code: "guided_pilot" } },
      { ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test", customerStrategy: "checkout",
        providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000019", taxPolicy: null },
      { ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test", customerStrategy: "existing",
        providerCustomerId: "cus_test",
        providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000026" },
    ]) {
      await expect(adapter.createCheckout(invalid as never))
        .rejects.toEqual(expect.objectContaining({ code: "STRIPE_REQUEST_INVALID" }));
    }
  });

  it("rejects unrestricted and test-fixture credentials at the production factory boundary", () => {
    for (const apiRestrictedKey of [
      ["sk", "live", "A".repeat(24)].join("_"),
      "syntholo_test_fake_api",
    ]) {
      expect(() => createStripeAdapter({ ...adapterConfig, apiRestrictedKey }))
        .toThrowError(expect.objectContaining({ code: "STRIPE_REQUEST_INVALID" }));
      expect(() => createStripeReadAdapter({ workerReadRestrictedKey: apiRestrictedKey }))
        .toThrowError(expect.objectContaining({ code: "STRIPE_REQUEST_INVALID" }));
    }
    const api = createStripeAdapter({
      ...adapterConfig,
      apiRestrictedKey: ["rk", "test", "A".repeat(24)].join("_"),
    });
    const reader = createStripeReadAdapter({
      workerReadRestrictedKey: ["rk", "test", "B".repeat(24)].join("_"),
    });
    expect(api).toEqual({
      createCheckout: expect.any(Function),
      createBillingPortal: expect.any(Function),
    });
    expect(reader).toEqual({
      retrieveCheckoutSession: expect.any(Function),
      retrieveSetupIntent: expect.any(Function),
      retrieveInvoice: expect.any(Function),
      retrieveSubscription: expect.any(Function),
      retrieveSubscriptionSchedule: expect.any(Function),
      retrieveRefund: expect.any(Function),
      retrievePaymentIntent: expect.any(Function),
      retrieveCharge: expect.any(Function),
      retrieveDispute: expect.any(Function),
    });
  });

  it("retrieves Checkout with expanded bounded line items", async () => {
    const fake = fakeClient();
    const adapter = createStripeAdapterWithClient(adapterConfig, fake.value);
    await expect(adapter.retrieveCheckoutSession("cs_test")).resolves.toMatchObject({
      kind: "checkout_session", providerSessionId: "cs_test",
      lineItems: [{ providerPriceId: "price_test", quantity: 1 }],
    });
    expect(fake.calls.checkoutRetrieve).toEqual([["cs_test", { expand: ["line_items"] }]]);
    const paginated = fakeClient({ checkoutSessionsRetrieve: async () => ({
      id: "cs_test", object: "checkout.session", livemode: false, mode: "payment",
      status: "complete", payment_status: "paid", customer: "cus_test", payment_intent: "pi_test",
      subscription: null, setup_intent: null, expires_at: 1_776_427_200, metadata: {},
      line_items: { data: [{ price: { id: "price_test" }, quantity: 1 }], has_more: true },
    }) });
    await expect(createStripeAdapterWithClient(adapterConfig, paginated.value).retrieveCheckoutSession("cs_test"))
      .rejects.toEqual(expect.objectContaining({ code: "STRIPE_PROVIDER_SHAPE_INVALID" }));
  });

  it("strictly normalizes every canonical webhook object without PII/provider bodies", async () => {
    const fake = fakeClient();
    const adapter = createStripeAdapterWithClient(adapterConfig, fake.value);
    const results = await Promise.all([
      adapter.retrieveSetupIntent("seti_test"),
      adapter.retrieveInvoice("in_test"),
      adapter.retrieveSubscription("sub_test"),
      adapter.retrieveSubscriptionSchedule("sub_sched_test"),
      adapter.retrieveRefund("re_test"),
      adapter.retrievePaymentIntent("pi_test"),
      adapter.retrieveCharge("ch_test"),
      adapter.retrieveDispute("dp_test"),
    ]);
    expect(results).toEqual([
      { kind: "setup_intent", providerSetupIntentId: "seti_test", livemode: false, status: "succeeded",
        providerCustomerId: "cus_test", providerPaymentMethodId: "pm_test",
        paymentMethodCustomerId: "cus_test", paymentMethodType: "card", metadata: {} },
      { kind: "invoice", providerInvoiceId: "in_test", livemode: false, status: "paid", paid: true,
        collectionMethod: "charge_automatically", currency: "usd", amountDue: 19_900, amountPaid: 19_900,
        amountRemaining: 0, providerCustomerId: "cus_test", subscriptionId: "sub_test",
        paymentReferences: [{ kind: "payment_intent", providerPaymentId: "pi_invoice_test", status: "paid",
          amountPaid: 19_900, amountRequested: 19_900, currency: "usd", paidAt: "2026-04-17T11:12:50.000Z" }],
        totalTaxAmount: 0, metadata: {}, lineItems: [{
          amount: 19_900, subtotal: 19_900, currency: "usd", providerPriceId: "price_test", quantity: 1,
          periodStart: "2026-04-16T16:00:00.000Z", periodEnd: "2026-05-17T16:00:00.000Z",
          taxes: [{ amount: 0, taxBehavior: "exclusive", taxabilityReason: "not_collecting", taxableAmount: 19_900 }],
        }] },
      { kind: "subscription", providerSubscriptionId: "sub_test", livemode: false, status: "active",
        providerCustomerId: "cus_test", cancelAtPeriodEnd: false, canceledAt: null, metadata: {},
        lineItems: [{ providerPriceId: "price_test", quantity: 1,
          currentPeriodStart: "2026-04-16T16:00:00.000Z", currentPeriodEnd: "2026-05-17T16:00:00.000Z" }] },
      { kind: "subscription_schedule", providerScheduleId: "sub_sched_test", livemode: false,
        status: "active", providerCustomerId: "cus_test", subscriptionId: "sub_test", metadata: {},
        phases: [{ startsAt: "2026-05-17T16:00:00.000Z", endsAt: "2026-06-17T16:00:00.000Z",
          lineItems: [{ providerPriceId: "price_test", quantity: 1 }] }] },
      { kind: "refund", providerRefundId: "re_test", status: "succeeded", amount: 39_900,
        currency: "usd", paymentIntentId: "pi_test", chargeId: "ch_test", metadata: {} },
      { kind: "payment_intent", providerPaymentIntentId: "pi_test", livemode: false, status: "succeeded",
        amount: 39_900, amountReceived: 39_900, currency: "usd", providerCustomerId: "cus_test",
        latestChargeId: "ch_test", metadata: {} },
      { kind: "charge", providerChargeId: "ch_test", livemode: false, paid: true, refunded: false,
        disputed: false, amount: 39_900, amountRefunded: 0, currency: "usd",
        providerCustomerId: "cus_test", paymentIntentId: "pi_test", invoiceId: null },
      { kind: "dispute", providerDisputeId: "dp_test", livemode: false,
        status: "warning_needs_response", amount: 39_900, currency: "usd",
        chargeId: "ch_test", paymentIntentId: "pi_test" },
    ]);
    expect(JSON.stringify(results)).not.toMatch(/email|address|url|payload/iu);
    expect(fake.calls.invoiceRetrieve).toEqual([["in_test", { expand: ["payments"] }]]);
    expect(fake.calls.subscriptionRetrieve).toEqual([["sub_test", {}]]);
    expect(fake.calls.setupIntentRetrieve).toEqual([["seti_test", { expand: ["payment_method"] }]]);

    for (const paymentMethod of [
      null,
      { id: "pm_test", object: "payment_method", customer: null, type: "card" },
      { id: "pm_test", object: "payment_method", customer: "cus_other", type: "card" },
    ]) {
      const invalid = fakeClient({ setupIntentsRetrieve: async () => ({
        id: "seti_test", object: "setup_intent", livemode: false, status: "succeeded",
        customer: "cus_test", payment_method: paymentMethod, metadata: {},
      }) });
      await expect(createStripeAdapterWithClient(adapterConfig, invalid.value).retrieveSetupIntent("seti_test"))
        .rejects.toEqual(expect.objectContaining({ code: "STRIPE_PROVIDER_SHAPE_INVALID" }));
    }

    const unsupportedInvoicePayment = fakeClient({ invoicesRetrieve: async () => ({
      id: "in_test", object: "invoice", livemode: false, status: "paid", paid: true,
      collection_method: "charge_automatically", currency: "usd", amount_due: 19_900,
      amount_paid: 19_900, amount_remaining: 0, customer: "cus_test", metadata: {}, parent: null,
      payments: { data: [{ id: "inpay_test", object: "invoice_payment", status: "paid", amount_paid: 19_900,
        amount_requested: 19_900, currency: "usd", invoice: "in_test", is_default: true, livemode: false,
        status_transitions: { canceled_at: null, paid_at: 1_776_424_370 },
        payment: { type: "payment_record", payment_record: "pr_test" } }], has_more: false },
      lines: { data: [{ id: "il_test", object: "line_item", amount: 19_900, subtotal: 19_900,
        currency: "usd", period: { start: 1_776_355_200, end: 1_779_033_600 }, quantity: 1,
        pricing: { type: "price_details", price_details: { price: "price_test", product: "prod_test" } },
        taxes: [] }], has_more: false },
    }) });
    await expect(createStripeAdapterWithClient(adapterConfig, unsupportedInvoicePayment.value).retrieveInvoice("in_test"))
      .rejects.toEqual(expect.objectContaining({ code: "STRIPE_PROVIDER_SHAPE_INVALID" }));

    const unknownPaymentStatus = fakeClient({ paymentIntentsRetrieve: async () => ({
      id: "pi_test", object: "payment_intent", livemode: false, status: "future_status",
      amount: 39_900, amount_received: 39_900, currency: "usd", customer: "cus_test",
      latest_charge: "ch_test", metadata: {},
    }) });
    await expect(createStripeAdapterWithClient(adapterConfig, unknownPaymentStatus.value)
      .retrievePaymentIntent("pi_test"))
      .rejects.toEqual(expect.objectContaining({ code: "STRIPE_PROVIDER_SHAPE_INVALID" }));
    const unknownDisputeStatus = fakeClient({ disputesRetrieve: async () => ({
      id: "dp_test", object: "dispute", livemode: false, status: "future_status",
      amount: 39_900, currency: "usd", charge: "ch_test", payment_intent: "pi_test",
    }) });
    await expect(createStripeAdapterWithClient(adapterConfig, unknownDisputeStatus.value)
      .retrieveDispute("dp_test"))
      .rejects.toEqual(expect.objectContaining({ code: "STRIPE_PROVIDER_SHAPE_INVALID" }));
    const missingDisputeCharge = fakeClient({ disputesRetrieve: async () => ({
      id: "dp_test", object: "dispute", livemode: false, status: "needs_response",
      amount: 39_900, currency: "usd", charge: null, payment_intent: "pi_test",
    }) });
    await expect(createStripeAdapterWithClient(adapterConfig, missingDisputeCharge.value)
      .retrieveDispute("dp_test"))
      .rejects.toEqual(expect.objectContaining({ code: "STRIPE_PROVIDER_SHAPE_INVALID" }));
    const unlinkedRefund = fakeClient({ refundsRetrieve: async () => ({
      id: "re_test", object: "refund", status: "succeeded", amount: 39_900,
      currency: "usd", payment_intent: null, charge: null, metadata: {},
    }) });
    await expect(createStripeAdapterWithClient(adapterConfig, unlinkedRefund.value)
      .retrieveRefund("re_test"))
      .rejects.toEqual(expect.objectContaining({ code: "STRIPE_PROVIDER_SHAPE_INVALID" }));
  });

  it.each([
    ["timeout", { type: "StripeConnectionError", code: "ETIMEDOUT" }, true, "STRIPE_DEPENDENCY_UNAVAILABLE"],
    ["rate limit", { type: "StripeRateLimitError", statusCode: 429 }, true, "STRIPE_DEPENDENCY_UNAVAILABLE"],
    ["provider 5xx", { type: "StripeAPIError", statusCode: 503 }, true, "STRIPE_DEPENDENCY_UNAVAILABLE"],
    ["provider 4xx", { type: "StripeInvalidRequestError", statusCode: 400 }, false, "STRIPE_REQUEST_INVALID"],
  ])("maps %s to a safe typed error without hidden cause", async (_label, providerError, retryable, code) => {
    const fake = fakeClient({ checkoutSessionsCreate: async () => {
      throw Object.assign(new Error("provider-private-body-marker"), providerError, {
        raw: { body: "provider-private-body-marker" },
      });
    } });
    const adapter = createStripeAdapterWithClient(adapterConfig, fake.value);
    let caught: unknown;
    try {
      await adapter.createCheckout({
        ...oneTimeCommon, kind: "one_time", providerPriceId: "price_test",
        providerIdempotencyKey: "checkout:01915eb4-207a-7000-8000-000000000011",
        customerStrategy: "checkout",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StripeAdapterError);
    expect(caught).toEqual(expect.objectContaining({ code, retryable }));
    expect((caught as Error).cause).toBeUndefined();
    expect(JSON.stringify(caught)).not.toContain("provider-private-body-marker");
    expect(String(caught)).not.toContain("provider-private-body-marker");
  });
});

const currentSecret = "test_only_local_webhook_current";
const previousSecret = "test_only_local_webhook_previous";
const secrets = [
  { keyId: "stripe_webhook_2026_08", secret: currentSecret },
  { keyId: "stripe_webhook_2026_07", secret: previousSecret },
];
const webhookNow = new Date("2026-08-15T12:00:00.000Z");

function signature(rawBody: Buffer, timestamp: number, secret = currentSecret) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex")}`;
}

function event(overrides: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({
    id: "evt_test", object: "event", api_version: "2026-06-24.dahlia",
    created: 1_776_424_370, livemode: false, pending_webhooks: 1,
    request: { id: null, idempotency_key: null }, type: "invoice.paid",
    data: { object: { id: "in_test", object: "invoice" } },
    ...overrides,
  }));
}

const binding = {
  receiverAccountId: "acct_test", expectedLivemode: false,
  expectedApiVersion: "2026-06-24.dahlia" as const,
  expectedEventAccount: null, expectedEventContext: null,
};

function verify(rawBody: Buffer, stripeSignature: string) {
  return verifyAndNormalizeStripeWebhook({
    rawBody, signature: stripeSignature, endpointSecrets: secrets, binding, now: webhookNow,
  });
}

describe("Stripe exact raw-byte webhook verifier", () => {
  it("verifies and minimizes a valid direct-account event with the matched key ID", () => {
    const rawBody = event();
    const timestamp = Math.floor(webhookNow.getTime() / 1_000) - 30;
    expect(verify(rawBody, signature(rawBody, timestamp))).toEqual({
      status: "accepted", verifiedWithKeyId: "stripe_webhook_2026_08",
      envelope: {
        eventId: "evt_test", eventType: "invoice.paid", knownEvent: true,
        objectTypeValid: true, livemode: false, apiVersion: "2026-06-24.dahlia",
        providerCreatedAt: "2026-04-17T11:12:50.000Z", dataObjectType: "invoice",
        dataObjectId: "in_test", receiverAccountId: "acct_test", eventAccount: null,
        eventContext: null, rawBodySha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(verify(rawBody, signature(rawBody, timestamp, previousSecret))).toMatchObject({
      status: "accepted", verifiedWithKeyId: "stripe_webhook_2026_07",
    });
  });

  it.each([["missing", ""], ["malformed", "not-a-signature"]])(
    "rejects a %s signature distinctly from event/context failures",
    (_label, stripeSignature) => expect(() => verify(event(), stripeSignature))
      .toThrowError(new Error("WEBHOOK_SIGNATURE_INVALID")),
  );

  it.each([
    ["stale", (body: Buffer) => signature(body, Math.floor(webhookNow.getTime() / 1_000) - 301), event()],
    ["wrong secret", (body: Buffer) => signature(body, Math.floor(webhookNow.getTime() / 1_000), "another_test_secret"), event()],
    ["body mutation", () => signature(event(), Math.floor(webhookNow.getTime() / 1_000)), Buffer.concat([event(), Buffer.from(" ")])],
  ])("rejects %s without leaking verification details", (_label, header, rawBody) => {
    expect(() => verify(rawBody, header(rawBody))).toThrowError(new Error("WEBHOOK_SIGNATURE_INVALID"));
  });

  it("classifies signed but unparsable JSON as the stable signature-invalid boundary", () => {
    const rawBody = Buffer.from("{not-json}");
    expect(() => verify(rawBody, signature(rawBody, Math.floor(webhookNow.getTime() / 1_000))))
      .toThrowError(new Error("WEBHOOK_SIGNATURE_INVALID"));
  });

  it.each([
    ["livemode", { livemode: true }],
    ["API version", { api_version: "2026-03-25.dahlia" }],
    ["event account", { account: "acct_unexpected" }],
    ["event context", { context: "ctx_unexpected" }],
    ["missing API version", { api_version: null }],
  ])("returns a terminal-safe envelope for a correctly signed wrong %s", (_label, override) => {
    const rawBody = event(override);
    expect(verify(rawBody, signature(rawBody, Math.floor(webhookNow.getTime() / 1_000))))
      .toMatchObject({ status: "terminal_context_mismatch", envelope: { eventId: "evt_test" } });
  });

  it("derives the exact event allowlist and known object type", () => {
    const wrongObject = event({ data: { object: { id: "cus_test", object: "customer" } } });
    expect(verify(wrongObject, signature(wrongObject, Math.floor(webhookNow.getTime() / 1_000))))
      .toMatchObject({ status: "terminal_event_mismatch", envelope: {
        eventType: "invoice.paid", knownEvent: true, objectTypeValid: false,
      } });
    const unknown = event({
      type: "customer.created", data: { object: { id: "cus_test", object: "customer" } },
    });
    expect(verify(unknown, signature(unknown, Math.floor(webhookNow.getTime() / 1_000))))
      .toMatchObject({ status: "accepted", envelope: { knownEvent: false, objectTypeValid: true } });
  });

  it("accepts exactly 1 MiB and rejects one byte more", () => {
    const base = event();
    const exact = Buffer.concat([base, Buffer.alloc(1_048_576 - base.byteLength, 0x20)]);
    const timestamp = Math.floor(webhookNow.getTime() / 1_000);
    expect(verify(exact, signature(exact, timestamp))).toMatchObject({ status: "accepted" });
    const oversized = Buffer.concat([exact, Buffer.from(" ")]);
    expect(() => verify(oversized, signature(oversized, timestamp)))
      .toThrowError(new Error("WEBHOOK_SIGNATURE_INVALID"));
  });
});
