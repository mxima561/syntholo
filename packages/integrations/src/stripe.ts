import { createHash } from "node:crypto";
import Stripe from "stripe";
import {
  KNOWN_STRIPE_EVENT_OBJECT_TYPES,
  NormalizedStripeChargeSchema,
  NormalizedStripeCheckoutSessionSchema,
  NormalizedStripeDisputeSchema,
  NormalizedStripeInvoiceSchema,
  NormalizedStripePaymentIntentSchema,
  NormalizedStripeRefundSchema,
  NormalizedStripeSetupIntentSchema,
  NormalizedStripeSubscriptionScheduleSchema,
  NormalizedStripeSubscriptionSchema,
  SafeStripeMetadataSchema,
  STRIPE_API_VERSION,
  StripeEventEnvelopeSchema,
  StripeMetadataSchema,
  type StripeMetadata,
} from "@syntholo/contracts/commerce";

export { STRIPE_API_VERSION };

type UnknownRecord = Readonly<Record<string, unknown>>;
type RequestOptions = Readonly<{ idempotencyKey: string }>;
const restrictedApiKey = /^rk_(?:test|live)_[A-Za-z0-9]{16,}$/u;
const actionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type StripeClientPort = Readonly<{
  checkoutSessionsCreate(params: UnknownRecord, options: RequestOptions): Promise<unknown>;
  checkoutSessionsRetrieve(id: string, params: UnknownRecord): Promise<unknown>;
  setupIntentsRetrieve(id: string, params: UnknownRecord): Promise<unknown>;
  invoicesRetrieve(id: string, params: UnknownRecord): Promise<unknown>;
  subscriptionsRetrieve(id: string, params: UnknownRecord): Promise<unknown>;
  subscriptionSchedulesRetrieve(id: string): Promise<unknown>;
  refundsRetrieve(id: string): Promise<unknown>;
  paymentIntentsRetrieve(id: string): Promise<unknown>;
  chargesRetrieve(id: string): Promise<unknown>;
  disputesRetrieve(id: string): Promise<unknown>;
  billingPortalSessionsCreate(params: UnknownRecord, options: RequestOptions): Promise<unknown>;
}>;

export class StripeAdapterError extends Error {
  readonly code: "STRIPE_DEPENDENCY_UNAVAILABLE" | "STRIPE_REQUEST_INVALID" | "STRIPE_PROVIDER_SHAPE_INVALID";
  readonly retryable: boolean;

  constructor(
    code: StripeAdapterError["code"],
    retryable: boolean,
  ) {
    super(code);
    this.name = "StripeAdapterError";
    this.code = code;
    this.retryable = retryable;
  }
}

function requestInvalid(): never {
  throw new StripeAdapterError("STRIPE_REQUEST_INVALID", false);
}

function shapeInvalid(): never {
  throw new StripeAdapterError("STRIPE_PROVIDER_SHAPE_INVALID", false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value)) return shapeInvalid();
  return value;
}

function inputId(value: unknown): string {
  try {
    return providerId(value);
  } catch {
    return requestInvalid();
  }
}

function idOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return providerId(value);
  if (isRecord(value)) return providerId(value.id);
  return shapeInvalid();
}

function boolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : shapeInvalid();
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : shapeInvalid();
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  return typeof value === "string" && values.includes(value) ? value as T[number] : shapeInvalid();
}

function instant(seconds: unknown): string {
  const value = integer(seconds);
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : shapeInvalid();
}

function nullableInstant(seconds: unknown): string | null {
  return seconds === null ? null : instant(seconds);
}

function metadata(value: unknown): StripeMetadata | Partial<StripeMetadata> {
  const parsed = SafeStripeMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : shapeInvalid();
}

function exactKeys(value: UnknownRecord, allowed: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) requestInvalid();
}

function exactHttpsUrl(value: unknown, expectedOrigin?: string): string {
  if (typeof value !== "string") return shapeInvalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return shapeInvalid();
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
    || url.hash !== "" || (expectedOrigin !== undefined && url.origin !== expectedOrigin)) return shapeInvalid();
  return url.toString();
}

function inputHttpsUrl(value: unknown): string {
  try {
    return exactHttpsUrl(value);
  } catch {
    return requestInvalid();
  }
}

function inputCanonicalUrl(value: unknown, path: string): string {
  const parsed = new URL(inputHttpsUrl(value));
  if (parsed.pathname !== path || parsed.search !== "") return requestInvalid();
  return parsed.toString();
}

function safeProviderError(error: unknown): StripeAdapterError {
  if (error instanceof StripeAdapterError) return error;
  const value = isRecord(error) ? error : {};
  const type = typeof value.type === "string" ? value.type : "";
  const status = typeof value.statusCode === "number" ? value.statusCode : null;
  const retryable = type === "StripeConnectionError"
    || type === "StripeRateLimitError"
    || status === 429
    || (status !== null && status >= 500);
  return retryable
    ? new StripeAdapterError("STRIPE_DEPENDENCY_UNAVAILABLE", true)
    : new StripeAdapterError("STRIPE_REQUEST_INVALID", false);
}

async function providerCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw safeProviderError(error);
  }
}

type TaxPolicy = Readonly<{ kind: "disabled" }> | Readonly<{
  kind: "approved";
  registrationAttestationId: string;
  catalogAttestationId: string;
  productTaxCode: string;
}>;

type CommonCheckout = Readonly<{
  integrationIdentifier: string;
  metadata: StripeMetadata;
  taxPolicy: TaxPolicy;
  providerIdempotencyKey: string;
}>;

type PricedCheckout = CommonCheckout & Readonly<{
  providerPriceId: string;
  customerStrategy: "checkout" | "create" | "existing";
  providerCustomerId?: string;
}>;

export type StripeCheckoutInput =
  | (PricedCheckout & Readonly<{ kind: "one_time"; invoicePolicy: "receipt_only" | "formal_invoice" }>)
  | (PricedCheckout & Readonly<{ kind: "business_os_setup" }>)
  | (PricedCheckout & Readonly<{ kind: "business_os_recurring" }>)
  | (PricedCheckout & Readonly<{ kind: "operator_club_subscription" }>)
  | (CommonCheckout & Readonly<{
    kind: "operator_club_setup";
    customerStrategy: "existing";
    providerCustomerId: string;
  }>);

const commonKeys = [
  "kind", "integrationIdentifier", "metadata", "taxPolicy",
  "providerIdempotencyKey", "customerStrategy",
] as const;

function checkoutParameters(input: StripeCheckoutInput, urls: Readonly<{
  checkoutSuccessUrl: string;
  checkoutCancelUrl: string;
}>): Readonly<{
  params: UnknownRecord;
  options: RequestOptions;
}> {
  if (!isRecord(input)) return requestInvalid();
  const setup = input.kind === "operator_club_setup";
  exactKeys(input, setup
    ? [...commonKeys, "providerCustomerId"]
    : [...commonKeys, "providerPriceId", ...(input.kind === "one_time" ? ["invoicePolicy"] : []),
      ...(input.providerCustomerId === undefined ? [] : ["providerCustomerId"])]);
  if (!/^syntholo_[a-z]{8}$/u.test(input.integrationIdentifier)) return requestInvalid();
  const parsedMetadata = StripeMetadataSchema.safeParse(input.metadata);
  if (!parsedMetadata.success) return requestInvalid();
  const idempotencyKey = inputId(input.providerIdempotencyKey);
  const prefix = input.kind === "business_os_setup" ? "business_os_setup_checkout:"
    : input.kind === "business_os_recurring" ? "business_os_recurring_checkout:"
      : input.kind === "operator_club_setup" ? "club_setup_checkout:"
        : input.kind === "operator_club_subscription" ? "club_subscription_checkout:"
          : "checkout:";
  const persistedActionId = idempotencyKey.slice(prefix.length);
  if (!idempotencyKey.startsWith(prefix)
    || !actionId.test(persistedActionId)) {
    return requestInvalid();
  }
  const offer = parsedMetadata.data.offer_code;
  const recurringPolicy = parsedMetadata.data.recurring_policy_version;
  const pilotAuthorization = parsedMetadata.data.pilot_authorization_id;
  const coherent = input.kind === "one_time"
    ? (offer === "self_paced" || offer === "guided_pilot") && recurringPolicy === undefined
    : input.kind === "business_os_setup"
      ? offer === "business_os" && recurringPolicy === undefined
      : input.kind === "business_os_recurring"
        ? offer === "business_os" && recurringPolicy !== undefined
        : (offer === "operator_club_monthly" || offer === "operator_club_annual") && recurringPolicy !== undefined;
  if (!coherent) return requestInvalid();
  if ((offer === "guided_pilot") !== (pilotAuthorization !== undefined)) return requestInvalid();
  const common: Record<string, unknown> = {
    mode: setup ? "setup" : input.kind === "business_os_recurring" || input.kind === "operator_club_subscription"
      ? "subscription" : "payment",
    success_url: urls.checkoutSuccessUrl,
    cancel_url: urls.checkoutCancelUrl,
    metadata: parsedMetadata.data,
    integration_identifier: input.integrationIdentifier,
  };
  if (!isRecord(input.taxPolicy)) return requestInvalid();
  if (setup) {
    if (input.customerStrategy !== "existing" || input.taxPolicy.kind !== "disabled"
      || Object.keys(input.taxPolicy).length !== 1) return requestInvalid();
    common.currency = "usd";
    common.customer = inputId(input.providerCustomerId);
    common.setup_intent_data = { metadata: parsedMetadata.data };
    return { params: common, options: { idempotencyKey } };
  }
  const priceId = inputId(input.providerPriceId);
  common.line_items = [{ price: priceId, quantity: 1 }];
  if (input.customerStrategy === "create") {
    if (input.kind !== "business_os_setup" || input.providerCustomerId !== undefined) return requestInvalid();
    common.customer_creation = "always";
  } else if (input.customerStrategy === "existing") {
    if (input.providerCustomerId === undefined || input.kind === "one_time") return requestInvalid();
    common.customer = inputId(input.providerCustomerId);
  } else if (input.customerStrategy !== "checkout" || input.providerCustomerId !== undefined || input.kind !== "one_time") {
    return requestInvalid();
  }
  const tax = input.taxPolicy;
  if (tax.kind === "disabled") {
    if (Object.keys(tax).length !== 1) return requestInvalid();
    common.automatic_tax = { enabled: false };
  } else if (tax.kind === "approved"
    && Object.keys(tax).length === 4
    && [tax.registrationAttestationId, tax.catalogAttestationId]
      .every((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value))
    && typeof tax.productTaxCode === "string" && /^txcd_[A-Za-z0-9._:-]+$/u.test(tax.productTaxCode)) {
    common.automatic_tax = { enabled: true };
  } else return requestInvalid();
  if (input.kind === "business_os_setup") {
    common.payment_intent_data = { metadata: parsedMetadata.data, setup_future_usage: "off_session" };
  } else if (input.kind === "business_os_recurring" || input.kind === "operator_club_subscription") {
    common.subscription_data = { metadata: parsedMetadata.data };
  } else {
    common.payment_intent_data = { metadata: parsedMetadata.data };
    if (input.invoicePolicy === "formal_invoice") common.invoice_creation = { enabled: true };
    else if (input.invoicePolicy !== "receipt_only") return requestInvalid();
  }
  return { params: common, options: { idempotencyKey } };
}

function normalizeCheckout(value: unknown) {
  if (!isRecord(value) || value.object !== "checkout.session") return shapeInvalid();
  const lineItems = value.line_items;
  if (!isRecord(lineItems) || lineItems.has_more !== false || !Array.isArray(lineItems.data)
    || lineItems.data.length > 1) return shapeInvalid();
  const normalizedItems = lineItems.data.map((item) => {
    if (!isRecord(item) || !isRecord(item.price) || item.quantity !== 1) return shapeInvalid();
    return { providerPriceId: providerId(item.price.id), quantity: 1 as const };
  });
  const result = {
    kind: "checkout_session" as const,
    providerSessionId: providerId(value.id),
    livemode: boolean(value.livemode),
    mode: enumValue(value.mode, ["payment", "setup", "subscription"] as const),
    status: enumValue(value.status, ["open", "complete", "expired"] as const),
    paymentStatus: enumValue(value.payment_status, ["paid", "unpaid", "no_payment_required"] as const),
    providerCustomerId: idOf(value.customer),
    paymentIntentId: idOf(value.payment_intent),
    subscriptionId: idOf(value.subscription),
    setupIntentId: idOf(value.setup_intent),
    expiresAt: instant(value.expires_at),
    metadata: metadata(value.metadata),
    lineItems: normalizedItems,
  };
  const parsed = NormalizedStripeCheckoutSessionSchema.safeParse(result);
  return parsed.success ? parsed.data : shapeInvalid();
}

function normalizeSetupIntent(value: unknown) {
  if (!isRecord(value) || value.object !== "setup_intent") return shapeInvalid();
  const paymentMethod = value.payment_method;
  if (paymentMethod !== null && (!isRecord(paymentMethod) || paymentMethod.object !== "payment_method")) {
    return shapeInvalid();
  }
  const result = {
    kind: "setup_intent" as const,
    providerSetupIntentId: providerId(value.id),
    livemode: boolean(value.livemode),
    status: enumValue(value.status, [
      "requires_payment_method", "requires_confirmation", "requires_action", "processing", "canceled", "succeeded",
    ] as const),
    providerCustomerId: idOf(value.customer),
    providerPaymentMethodId: paymentMethod === null ? null : providerId(paymentMethod.id),
    paymentMethodCustomerId: paymentMethod === null ? null : idOf(paymentMethod.customer),
    paymentMethodType: paymentMethod === null ? null : providerId(paymentMethod.type),
    metadata: metadata(value.metadata),
  };
  const parsed = NormalizedStripeSetupIntentSchema.safeParse(result);
  return parsed.success ? parsed.data : shapeInvalid();
}

function list(value: unknown): readonly unknown[] {
  if (!isRecord(value) || value.has_more !== false || !Array.isArray(value.data)) return shapeInvalid();
  return value.data;
}

function normalizeInvoice(value: unknown) {
  if (!isRecord(value) || value.object !== "invoice") return shapeInvalid();
  const parent = value.parent;
  const subscriptionId = parent === null ? null
    : isRecord(parent) && parent.type === "subscription_details" && isRecord(parent.subscription_details)
      ? idOf(parent.subscription_details.subscription)
      : null;
  const payments = list(value.payments);
  if (payments.length > 20) return shapeInvalid();
  const paymentReferences = payments.map((payment) => {
    if (!isRecord(payment) || payment.object !== "invoice_payment" || !isRecord(payment.payment)
      || !isRecord(payment.status_transitions)) return shapeInvalid();
    const kind = enumValue(payment.payment.type, ["payment_intent", "charge"] as const);
    const providerPaymentId = kind === "payment_intent"
      ? idOf(payment.payment.payment_intent)
      : idOf(payment.payment.charge);
    if (providerPaymentId === null) return shapeInvalid();
    return {
      kind,
      providerPaymentId,
      status: enumValue(payment.status, ["open", "paid", "canceled"] as const),
      amountPaid: payment.amount_paid === null ? null : integer(payment.amount_paid),
      amountRequested: integer(payment.amount_requested),
      currency: enumValue(payment.currency, ["usd"] as const),
      paidAt: nullableInstant(payment.status_transitions.paid_at),
    };
  });
  const lineItems = list(value.lines).map((line) => {
    if (!isRecord(line) || !isRecord(line.period) || !isRecord(line.pricing)
      || !isRecord(line.pricing.price_details) || line.quantity !== 1) return shapeInvalid();
    const taxes = line.taxes === null ? [] : Array.isArray(line.taxes) ? line.taxes : shapeInvalid();
    const normalizedTaxes = taxes.map((tax) => {
      if (!isRecord(tax)) return shapeInvalid();
      return {
        amount: integer(tax.amount),
        taxBehavior: enumValue(tax.tax_behavior, ["inclusive", "exclusive"] as const),
        taxabilityReason: enumValue(tax.taxability_reason, [
          "customer_exempt", "not_available", "not_collecting", "not_subject_to_tax", "not_supported",
          "portion_product_exempt", "portion_reduced_rated", "portion_standard_rated", "product_exempt",
          "product_exempt_holiday", "proportionally_rated", "reduced_rated", "reverse_charge",
          "standard_rated", "taxable_basis_reduced", "zero_rated",
        ] as const),
        taxableAmount: tax.taxable_amount === null ? null : integer(tax.taxable_amount),
      };
    });
    return {
      amount: integer(line.amount),
      subtotal: integer(line.subtotal),
      currency: enumValue(line.currency, ["usd"] as const),
      providerPriceId: idOf(line.pricing.price_details.price) ?? shapeInvalid(),
      quantity: 1 as const,
      periodStart: instant(line.period.start),
      periodEnd: instant(line.period.end),
      taxes: normalizedTaxes,
    };
  });
  const result = {
    kind: "invoice" as const,
    providerInvoiceId: providerId(value.id),
    livemode: boolean(value.livemode),
    status: enumValue(value.status, ["draft", "open", "paid", "uncollectible", "void"] as const),
    paid: boolean(value.paid),
    collectionMethod: enumValue(value.collection_method, ["charge_automatically", "send_invoice"] as const),
    currency: enumValue(value.currency, ["usd"] as const),
    amountDue: integer(value.amount_due),
    amountPaid: integer(value.amount_paid),
    amountRemaining: integer(value.amount_remaining),
    totalTaxAmount: lineItems.reduce((sum, line) => sum
      + line.taxes.reduce((taxSum, tax) => taxSum + tax.amount, 0), 0),
    providerCustomerId: idOf(value.customer),
    subscriptionId,
    paymentReferences,
    metadata: metadata(value.metadata ?? {}),
    lineItems,
  };
  const parsed = NormalizedStripeInvoiceSchema.safeParse(result);
  return parsed.success ? parsed.data : shapeInvalid();
}

function normalizeSubscription(value: unknown) {
  if (!isRecord(value) || value.object !== "subscription") return shapeInvalid();
  const items = list(value.items);
  if (items.length !== 1 || !isRecord(items[0]) || items[0].quantity !== 1) {
    return shapeInvalid();
  }
  const item = items[0];
  const price = item.price;
  if (!isRecord(price)) return shapeInvalid();
  const result = {
    kind: "subscription" as const,
    providerSubscriptionId: providerId(value.id),
    livemode: boolean(value.livemode),
    status: enumValue(value.status, [
      "incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused",
    ] as const),
    providerCustomerId: idOf(value.customer),
    cancelAtPeriodEnd: boolean(value.cancel_at_period_end),
    canceledAt: nullableInstant(value.canceled_at),
    metadata: metadata(value.metadata),
    lineItems: [{
      providerPriceId: providerId(price.id),
      quantity: 1 as const,
      currentPeriodStart: instant(item.current_period_start),
      currentPeriodEnd: instant(item.current_period_end),
    }],
  };
  const parsed = NormalizedStripeSubscriptionSchema.safeParse(result);
  return parsed.success ? parsed.data : shapeInvalid();
}

function normalizeSchedule(value: unknown) {
  if (!isRecord(value) || value.object !== "subscription_schedule" || !Array.isArray(value.phases)) return shapeInvalid();
  const result = {
    kind: "subscription_schedule" as const,
    providerScheduleId: providerId(value.id),
    livemode: boolean(value.livemode),
    status: enumValue(value.status, ["not_started", "active", "completed", "released", "canceled"] as const),
    providerCustomerId: idOf(value.customer),
    subscriptionId: idOf(value.subscription),
    metadata: metadata(value.metadata),
    phases: value.phases.map((phase) => {
      if (!isRecord(phase) || !Array.isArray(phase.items) || phase.items.length !== 1
        || !isRecord(phase.items[0]) || phase.items[0].quantity !== 1) return shapeInvalid();
      return {
        startsAt: instant(phase.start_date),
        endsAt: instant(phase.end_date),
        lineItems: [{ providerPriceId: idOf(phase.items[0].price) ?? shapeInvalid(), quantity: 1 as const }],
      };
    }),
  };
  const parsed = NormalizedStripeSubscriptionScheduleSchema.safeParse(result);
  return parsed.success ? parsed.data : shapeInvalid();
}

function normalizeRefund(value: unknown) {
  if (!isRecord(value) || value.object !== "refund") return shapeInvalid();
  const result = {
    kind: "refund" as const,
    providerRefundId: providerId(value.id),
    status: enumValue(value.status, ["pending", "requires_action", "succeeded", "failed", "canceled"] as const),
    amount: integer(value.amount), currency: enumValue(value.currency, ["usd"] as const),
    paymentIntentId: idOf(value.payment_intent), chargeId: idOf(value.charge), metadata: metadata(value.metadata),
  };
  const parsed = NormalizedStripeRefundSchema.safeParse(result);
  return parsed.success ? parsed.data : shapeInvalid();
}

function normalizePaymentIntent(value: unknown) {
  if (!isRecord(value) || value.object !== "payment_intent") return shapeInvalid();
  const result = {
    kind: "payment_intent" as const, providerPaymentIntentId: providerId(value.id), livemode: boolean(value.livemode),
    status: enumValue(value.status, [
      "requires_payment_method", "requires_confirmation", "requires_action", "processing",
      "requires_capture", "canceled", "succeeded",
    ] as const), amount: integer(value.amount), amountReceived: integer(value.amount_received),
    currency: enumValue(value.currency, ["usd"] as const), providerCustomerId: idOf(value.customer),
    latestChargeId: idOf(value.latest_charge), metadata: metadata(value.metadata),
  };
  const parsed = NormalizedStripePaymentIntentSchema.safeParse(result);
  return parsed.success ? parsed.data : shapeInvalid();
}

function normalizeCharge(value: unknown) {
  if (!isRecord(value) || value.object !== "charge") return shapeInvalid();
  const result = {
    kind: "charge" as const, providerChargeId: providerId(value.id), livemode: boolean(value.livemode),
    paid: boolean(value.paid), refunded: boolean(value.refunded), disputed: boolean(value.disputed),
    amount: integer(value.amount), amountRefunded: integer(value.amount_refunded),
    currency: enumValue(value.currency, ["usd"] as const), providerCustomerId: idOf(value.customer),
    paymentIntentId: idOf(value.payment_intent), invoiceId: idOf(value.invoice),
  };
  const parsed = NormalizedStripeChargeSchema.safeParse(result);
  return parsed.success ? parsed.data : shapeInvalid();
}

function normalizeDispute(value: unknown) {
  if (!isRecord(value) || value.object !== "dispute") return shapeInvalid();
  const result = {
    kind: "dispute" as const, providerDisputeId: providerId(value.id), livemode: boolean(value.livemode),
    status: enumValue(value.status, [
      "warning_needs_response", "warning_under_review", "warning_closed", "needs_response",
      "under_review", "won", "lost", "prevented",
    ] as const), amount: integer(value.amount), currency: enumValue(value.currency, ["usd"] as const),
    chargeId: idOf(value.charge) ?? shapeInvalid(), paymentIntentId: idOf(value.payment_intent),
  };
  const parsed = NormalizedStripeDisputeSchema.safeParse(result);
  return parsed.success ? parsed.data : shapeInvalid();
}

export function createStripeAdapterWithClient(
  config: Readonly<{
    checkoutSuccessUrl: string;
    checkoutCancelUrl: string;
    portalConfigurationId: string;
    portalReturnUrl: string;
  }>,
  client: StripeClientPort,
) {
  const checkoutSuccessUrl = inputCanonicalUrl(config.checkoutSuccessUrl, "/claim");
  const checkoutCancelUrl = inputCanonicalUrl(config.checkoutCancelUrl, "/pricing");
  const portalConfigurationId = inputId(config.portalConfigurationId);
  const portalReturnUrl = inputCanonicalUrl(config.portalReturnUrl, "/learn/settings/billing");
  const appOrigins = [checkoutSuccessUrl, checkoutCancelUrl, portalReturnUrl]
    .map((url) => new URL(url).origin);
  if (new Set(appOrigins).size !== 1) return requestInvalid();
  return Object.freeze({
    async createCheckout(input: StripeCheckoutInput) {
      const call = checkoutParameters(input, { checkoutSuccessUrl, checkoutCancelUrl });
      const value = await providerCall(() => client.checkoutSessionsCreate(call.params, call.options));
      if (!isRecord(value) || value.object !== "checkout.session") return shapeInvalid();
      return Object.freeze({
        providerSessionId: providerId(value.id),
        handoffUrl: exactHttpsUrl(value.url, "https://checkout.stripe.com"),
        expiresAt: instant(value.expires_at),
      });
    },
    async createBillingPortal(input: Readonly<{ providerCustomerId: string; providerIdempotencyKey: string }>) {
      if (!isRecord(input)) return requestInvalid();
      exactKeys(input, ["providerCustomerId", "providerIdempotencyKey"]);
      const idempotencyKey = inputId(input.providerIdempotencyKey);
      if (!idempotencyKey.startsWith("portal:") || !actionId.test(idempotencyKey.slice("portal:".length))) {
        return requestInvalid();
      }
      const value = await providerCall(() => client.billingPortalSessionsCreate({
        customer: inputId(input.providerCustomerId),
        configuration: portalConfigurationId,
        return_url: portalReturnUrl,
      }, { idempotencyKey }));
      if (!isRecord(value) || value.object !== "billing_portal.session") return shapeInvalid();
      return Object.freeze({
        providerSessionId: providerId(value.id),
        handoffUrl: exactHttpsUrl(value.url, "https://billing.stripe.com"),
      });
    },
    ...createStripeReadAdapterWithClient(client),
  });
}

function createStripeReadAdapterWithClient(client: StripeClientPort) {
  return Object.freeze({
    retrieveCheckoutSession: (id: string) => providerCall(async () =>
      normalizeCheckout(await client.checkoutSessionsRetrieve(inputId(id), { expand: ["line_items"] }))),
    retrieveSetupIntent: (id: string) => providerCall(async () =>
      normalizeSetupIntent(await client.setupIntentsRetrieve(inputId(id), { expand: ["payment_method"] }))),
    retrieveInvoice: (id: string) => providerCall(async () =>
      normalizeInvoice(await client.invoicesRetrieve(inputId(id), { expand: ["payments"] }))),
    retrieveSubscription: (id: string) => providerCall(async () =>
      normalizeSubscription(await client.subscriptionsRetrieve(inputId(id), {}))),
    retrieveSubscriptionSchedule: (id: string) => providerCall(async () =>
      normalizeSchedule(await client.subscriptionSchedulesRetrieve(inputId(id)))),
    retrieveRefund: (id: string) => providerCall(async () => normalizeRefund(await client.refundsRetrieve(inputId(id)))),
    retrievePaymentIntent: (id: string) => providerCall(async () =>
      normalizePaymentIntent(await client.paymentIntentsRetrieve(inputId(id)))),
    retrieveCharge: (id: string) => providerCall(async () => normalizeCharge(await client.chargesRetrieve(inputId(id)))),
    retrieveDispute: (id: string) => providerCall(async () => normalizeDispute(await client.disputesRetrieve(inputId(id)))),
  });
}

function officialClient(apiRestrictedKey: string): StripeClientPort {
  const stripe = new Stripe(apiRestrictedKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 10_000,
    telemetry: false,
  });
  return {
    checkoutSessionsCreate: (params, options) => stripe.checkout.sessions.create(
      params as Stripe.Checkout.SessionCreateParams,
      options,
    ),
    checkoutSessionsRetrieve: (id, params) => stripe.checkout.sessions.retrieve(
      id,
      params as Stripe.Checkout.SessionRetrieveParams,
    ),
    setupIntentsRetrieve: (id, params) => stripe.setupIntents.retrieve(
      id,
      params as Stripe.SetupIntentRetrieveParams,
    ),
    invoicesRetrieve: (id, params) => stripe.invoices.retrieve(id, params as Stripe.InvoiceRetrieveParams),
    subscriptionsRetrieve: (id, params) => stripe.subscriptions.retrieve(id, params as Stripe.SubscriptionRetrieveParams),
    subscriptionSchedulesRetrieve: (id) => stripe.subscriptionSchedules.retrieve(id),
    refundsRetrieve: (id) => stripe.refunds.retrieve(id),
    paymentIntentsRetrieve: (id) => stripe.paymentIntents.retrieve(id),
    chargesRetrieve: (id) => stripe.charges.retrieve(id),
    disputesRetrieve: (id) => stripe.disputes.retrieve(id),
    billingPortalSessionsCreate: (params, options) => stripe.billingPortal.sessions.create(
      params as Stripe.BillingPortal.SessionCreateParams,
      options,
    ),
  };
}

export function createStripeAdapter(input: Readonly<{
  apiRestrictedKey: string;
  checkoutSuccessUrl: string;
  checkoutCancelUrl: string;
  portalConfigurationId: string;
  portalReturnUrl: string;
}>) {
  if (!isRecord(input) || !restrictedApiKey.test(input.apiRestrictedKey)) return requestInvalid();
  const adapter = createStripeAdapterWithClient(input, officialClient(input.apiRestrictedKey));
  return Object.freeze({
    createCheckout: adapter.createCheckout,
    createBillingPortal: adapter.createBillingPortal,
  });
}

export function createStripeReadAdapter(input: Readonly<{ workerReadRestrictedKey: string }>) {
  if (!isRecord(input) || !restrictedApiKey.test(input.workerReadRestrictedKey)) return requestInvalid();
  return createStripeReadAdapterWithClient(officialClient(input.workerReadRestrictedKey));
}

export type StripeWebhookSecret = Readonly<{ keyId: string; secret: string }>;
export type StripeEndpointBinding = Readonly<{
  receiverAccountId: string;
  expectedLivemode: boolean;
  expectedApiVersion: typeof STRIPE_API_VERSION;
  expectedEventAccount: string | null;
  expectedEventContext: string | null;
}>;

export function verifyAndNormalizeStripeWebhook(input: Readonly<{
  rawBody: Buffer;
  signature: string;
  endpointSecrets: readonly StripeWebhookSecret[];
  binding: StripeEndpointBinding;
  now: Date;
}>) {
  if (!Buffer.isBuffer(input.rawBody) || input.rawBody.length === 0 || input.rawBody.length > 1_048_576
    || typeof input.signature !== "string" || input.signature.length === 0
    || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())
    || input.endpointSecrets.length < 1 || input.endpointSecrets.length > 2) {
    throw new Error("WEBHOOK_SIGNATURE_INVALID");
  }
  let verified: StripeWebhookSecret | null = null;
  let event: Stripe.Event | null = null;
  for (const candidate of input.endpointSecrets) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(candidate.keyId) || candidate.secret.length < 16) {
      throw new Error("WEBHOOK_SIGNATURE_INVALID");
    }
    try {
      const parsed = Stripe.webhooks.constructEvent(
        input.rawBody,
        input.signature,
        candidate.secret,
        300,
        undefined,
        input.now.getTime(),
      );
      verified = candidate;
      event = parsed;
      break;
    } catch {
      // Try the other explicitly configured rotation key without exposing why this key failed.
    }
  }
  if (verified === null || event === null) throw new Error("WEBHOOK_SIGNATURE_INVALID");
  if (!isRecord(event) || !isRecord(event.data) || !isRecord(event.data.object)) {
    throw new Error("WEBHOOK_EVENT_INVALID");
  }
  const dataObject = event.data.object;
  const eventType = providerId(event.type);
  const expectedObject = KNOWN_STRIPE_EVENT_OBJECT_TYPES[eventType as keyof typeof KNOWN_STRIPE_EVENT_OBJECT_TYPES];
  const dataObjectType = providerId(dataObject.object);
  const knownEvent = expectedObject !== undefined;
  const objectTypeValid = expectedObject === undefined || expectedObject === dataObjectType;
  const eventAccount = event.account === undefined ? null : idOf(event.account);
  const rawContext = (event as unknown as Record<string, unknown>).context;
  const eventContext = rawContext === undefined ? null : idOf(rawContext);
  const envelope = StripeEventEnvelopeSchema.parse({
    eventId: providerId(event.id),
    eventType,
    knownEvent,
    objectTypeValid,
    livemode: boolean(event.livemode),
    apiVersion: event.api_version === null ? null : providerId(event.api_version),
    providerCreatedAt: instant(event.created),
    dataObjectType,
    dataObjectId: providerId(dataObject.id),
    receiverAccountId: inputId(input.binding.receiverAccountId),
    eventAccount,
    eventContext,
    rawBodySha256: createHash("sha256").update(input.rawBody).digest("hex"),
  });
  const status = envelope.livemode !== input.binding.expectedLivemode
    || envelope.apiVersion !== input.binding.expectedApiVersion
    || envelope.eventAccount !== input.binding.expectedEventAccount
    || envelope.eventContext !== input.binding.expectedEventContext
    ? "terminal_context_mismatch" as const
    : !envelope.objectTypeValid
      ? "terminal_event_mismatch" as const
      : "accepted" as const;
  return Object.freeze({ status, verifiedWithKeyId: verified.keyId, envelope });
}
