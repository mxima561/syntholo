import { createHmac } from "node:crypto";
import type { StripeClientPort } from "@syntholo/integrations/testing/stripe";

type RecordedStripeCall = Readonly<{ operation: string; args: readonly unknown[] }>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function snapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

const objects = Object.freeze({
  checkoutSession: Object.freeze({
    id: "cs_syntholo_fixture", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_fixture",
    expires_at: 1_776_427_200, livemode: false, mode: "payment", status: "complete", payment_status: "paid",
    customer: "cus_syntholo_fixture", payment_intent: "pi_syntholo_fixture", subscription: null,
    setup_intent: null, metadata: {},
    line_items: { data: [{ price: { id: "price_syntholo_fixture" }, quantity: 1 }], has_more: false },
  }),
  setupIntent: Object.freeze({
    id: "seti_syntholo_fixture", object: "setup_intent", livemode: false, status: "succeeded",
    customer: "cus_syntholo_fixture", payment_method: {
      id: "pm_syntholo_fixture", object: "payment_method", customer: "cus_syntholo_fixture", type: "card",
    }, metadata: {},
  }),
  invoice: Object.freeze({
    id: "in_syntholo_fixture", object: "invoice", livemode: false, status: "paid", paid: true,
    collection_method: "charge_automatically", currency: "usd", amount_due: 19_900,
    amount_paid: 19_900, amount_remaining: 0, customer: "cus_syntholo_fixture", metadata: {},
    parent: { type: "subscription_details", subscription_details: {
      subscription: "sub_syntholo_fixture", metadata: {},
    } },
    payments: { data: [{ id: "inpay_syntholo_fixture", object: "invoice_payment", status: "paid",
      amount_paid: 19_900, amount_requested: 19_900, currency: "usd", invoice: "in_syntholo_fixture",
      is_default: true, livemode: false, status_transitions: { canceled_at: null, paid_at: 1_776_424_370 },
      payment: { type: "payment_intent", payment_intent: "pi_syntholo_fixture" } }], has_more: false },
    lines: { data: [{ id: "il_syntholo_fixture", object: "line_item", amount: 19_900,
      subtotal: 19_900, currency: "usd", period: { start: 1_776_355_200, end: 1_779_033_600 }, quantity: 1,
      pricing: { type: "price_details", price_details: {
        price: "price_syntholo_fixture", product: "prod_syntholo_fixture",
      }, unit_amount_decimal: "19900" }, taxes: [] }], has_more: false },
  }),
  subscription: Object.freeze({
    id: "sub_syntholo_fixture", object: "subscription", livemode: false, status: "active",
    customer: "cus_syntholo_fixture", cancel_at_period_end: false, canceled_at: null, metadata: {},
    items: { data: [{ id: "si_syntholo_fixture", object: "subscription_item",
      current_period_start: 1_776_355_200, current_period_end: 1_779_033_600,
      price: { id: "price_syntholo_fixture" }, quantity: 1 }], has_more: false },
  }),
  schedule: Object.freeze({
    id: "sub_sched_syntholo_fixture", object: "subscription_schedule", livemode: false,
    status: "active", customer: "cus_syntholo_fixture", subscription: "sub_syntholo_fixture",
    metadata: {}, phases: [{ start_date: 1_779_033_600, end_date: 1_781_712_000,
      items: [{ price: "price_syntholo_fixture", quantity: 1 }] }],
  }),
  refund: Object.freeze({
    id: "re_syntholo_fixture", object: "refund", status: "succeeded", amount: 39_900,
    currency: "usd", payment_intent: "pi_syntholo_fixture", charge: "ch_syntholo_fixture", metadata: {},
  }),
  paymentIntent: Object.freeze({
    id: "pi_syntholo_fixture", object: "payment_intent", livemode: false, status: "succeeded",
    amount: 39_900, amount_received: 39_900, currency: "usd", customer: "cus_syntholo_fixture",
    latest_charge: "ch_syntholo_fixture", metadata: {},
  }),
  charge: Object.freeze({
    id: "ch_syntholo_fixture", object: "charge", livemode: false, paid: true, refunded: false,
    disputed: false, amount: 39_900, amount_refunded: 0, currency: "usd",
    customer: "cus_syntholo_fixture", payment_intent: "pi_syntholo_fixture", invoice: null,
  }),
  dispute: Object.freeze({
    id: "dp_syntholo_fixture", object: "dispute", livemode: false, status: "warning_needs_response",
    amount: 39_900, currency: "usd", charge: "ch_syntholo_fixture", payment_intent: "pi_syntholo_fixture",
  }),
  portalSession: Object.freeze({
    id: "bps_syntholo_fixture", object: "billing_portal.session",
    url: "https://billing.stripe.com/p/session/syntholo_fixture",
  }),
});

const events = Object.freeze({
  invoicePaid: Object.freeze({
    id: "evt_syntholo_invoice_paid", object: "event", api_version: "2026-06-24.dahlia",
    created: 1_776_424_370, livemode: false, pending_webhooks: 1,
    request: { id: null, idempotency_key: null }, type: "invoice.paid",
    data: { object: { id: "in_syntholo_fixture", object: "invoice" } },
  }),
});

export function createDeterministicStripeFixture(input: Readonly<{ nodeEnv: string }>) {
  if (input.nodeEnv !== "test") throw new Error("STRIPE_TEST_FIXTURE_FORBIDDEN");
  const calls: RecordedStripeCall[] = [];
  const record = (operation: string, args: readonly unknown[], result: unknown) => {
    calls.push(snapshot({ operation, args }));
    return Promise.resolve(snapshot(result));
  };
  const client: StripeClientPort = {
    checkoutSessionsCreate: (params, options) => record("checkout.sessions.create", [params, options], objects.checkoutSession),
    checkoutSessionsRetrieve: (id, params) => record("checkout.sessions.retrieve", [id, params], objects.checkoutSession),
    setupIntentsRetrieve: (id, params) => record("setup_intents.retrieve", [id, params], objects.setupIntent),
    invoicesRetrieve: (id, params) => record("invoices.retrieve", [id, params], objects.invoice),
    subscriptionsRetrieve: (id, params) => record("subscriptions.retrieve", [id, params], objects.subscription),
    subscriptionSchedulesRetrieve: (id) => record("subscription_schedules.retrieve", [id], objects.schedule),
    refundsRetrieve: (id) => record("refunds.retrieve", [id], objects.refund),
    paymentIntentsRetrieve: (id) => record("payment_intents.retrieve", [id], objects.paymentIntent),
    chargesRetrieve: (id) => record("charges.retrieve", [id], objects.charge),
    disputesRetrieve: (id) => record("disputes.retrieve", [id], objects.dispute),
    billingPortalSessionsCreate: (params, options) => record(
      "billing_portal.sessions.create", [params, options], objects.portalSession,
    ),
  };
  return Object.freeze({
    client,
    get calls() { return snapshot(calls); },
    objects: snapshot(objects),
    events: snapshot(events),
    signWebhook(rawBody: Buffer, timestamp: number, key: "current" | "previous") {
      const secret = key === "current" ? "test_only_local_webhook_current" : "test_only_local_webhook_previous";
      const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
      return `t=${timestamp},v1=${digest}`;
    },
  });
}

export type DeterministicStripeFixture = ReturnType<typeof createDeterministicStripeFixture>;
