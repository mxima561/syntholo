import { z } from "zod";
import { AccountNameSchema, UtcMillisecondInstantSchema } from "../member-dashboard";

const OpaqueIdentifierSchema = z.string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const COMMERCE_ERROR_CODES = Object.freeze([
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
] as const);

export const CommerceErrorCodeSchema = z.enum(COMMERCE_ERROR_CODES);

export const CommerceOfferCodeSchema = z.enum([
  "scorecard",
  "self_paced",
  "guided_pilot",
  "operator_club_monthly",
  "operator_club_annual",
  "business_os",
]);

export const PaidCommerceOfferCodeSchema = CommerceOfferCodeSchema.exclude(["scorecard"]);

const OfferAvailabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available") }).strict(),
  z.object({
    state: z.literal("unavailable"),
    reason: z.enum([
      "OFFER_UNAVAILABLE",
      "CURRICULUM_GATE_BLOCKED",
      "BUSINESS_OS_NOT_READY",
      "ACADEMY_REQUIRED",
      "COMMERCE_HELD",
      "AUTHORIZATION_EXPIRED",
      "CATALOG_MISMATCH",
    ]),
  }).strict(),
]);

const DisplayPriceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("free"), currency: z.literal("usd"), unitAmount: z.literal(0) }).strict(),
  z.object({
    kind: z.literal("one_time"),
    currency: z.literal("usd"),
    unitAmount: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("recurring"),
    currency: z.literal("usd"),
    unitAmount: z.number().int().positive(),
    interval: z.enum(["month", "year"]),
  }).strict(),
  z.object({
    kind: z.literal("two_stage"),
    currency: z.literal("usd"),
    setupUnitAmount: z.number().int().positive(),
    recurringUnitAmount: z.number().int().positive(),
    recurringInterval: z.literal("month"),
  }).strict(),
]);

export const SafeOfferProjectionSchema = z.object({
  code: CommerceOfferCodeSchema,
  state: z.enum(["draft", "waitlist", "enabled", "paused"]),
  purchaseModel: z.enum(["free", "one_time", "recurring", "two_stage"]),
  displayPrice: DisplayPriceSchema,
  availability: OfferAvailabilitySchema,
  catalogVersion: OpaqueIdentifierSchema,
}).strict().superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: "custom", message: "Offer price model mismatch" });
  if (value.code === "scorecard") {
    if (value.purchaseModel !== "free" || value.displayPrice.kind !== "free") invalid();
    return;
  }
  if (value.code === "self_paced" || value.code === "guided_pilot") {
    if (value.purchaseModel !== "one_time" || value.displayPrice.kind !== "one_time") invalid();
    return;
  }
  if (value.code === "operator_club_monthly" || value.code === "operator_club_annual") {
    const interval = value.code === "operator_club_monthly" ? "month" : "year";
    if (value.purchaseModel !== "recurring"
      || value.displayPrice.kind !== "recurring"
      || value.displayPrice.interval !== interval) invalid();
    return;
  }
  if (value.purchaseModel !== "two_stage" || value.displayPrice.kind !== "two_stage") invalid();
});

export const SafeOfferListResponseSchema = z.object({
  offers: z.array(SafeOfferProjectionSchema).max(6),
  generatedAt: UtcMillisecondInstantSchema,
}).strict();

export const AcceptedPolicyVersionsSchema = z.object({
  terms: OpaqueIdentifierSchema,
  privacy: OpaqueIdentifierSchema,
  refund: OpaqueIdentifierSchema,
  recurring: OpaqueIdentifierSchema.optional(),
}).strict();

export const PublicCheckoutSelectionSchema = z.object({
  offerCode: z.enum(["self_paced", "business_os"]),
  email: z.string().email().max(320),
  businessName: AccountNameSchema,
  attributionId: z.string().uuid().optional(),
  acceptedPolicyVersions: AcceptedPolicyVersionsSchema,
}).strict();

export const MemberCheckoutSelectionSchema = z.object({
  offerCode: z.literal("business_os"),
}).strict();

export const OperatorClubQuoteSelectionSchema = z.object({
  cadence: z.enum(["monthly", "annual"]),
}).strict();

export const OperatorClubSubscriptionSelectionSchema = z.object({
  quoteId: z.string().uuid(),
}).strict();

export const BusinessOsSubscriptionSelectionSchema = z.object({}).strict();
export const BillingPortalSelectionSchema = z.object({}).strict();

export const CheckoutPendingResponseSchema = z.object({
  state: z.enum(["pending", "paid", "claim_sent", "failed", "expired"]),
  offerCode: PaidCommerceOfferCodeSchema,
  updatedAt: UtcMillisecondInstantSchema,
}).strict();

const StripeMetadataBaseSchema = z.object({
  checkout_authorization_id: OpaqueIdentifierSchema,
  offer_code: PaidCommerceOfferCodeSchema,
  catalog_version: OpaqueIdentifierSchema,
  attribution_id: OpaqueIdentifierSchema.optional(),
  pilot_authorization_id: OpaqueIdentifierSchema.optional(),
  refund_policy_version: OpaqueIdentifierSchema,
  recurring_policy_version: OpaqueIdentifierSchema.optional(),
}).strict();

export const StripeMetadataSchema = StripeMetadataBaseSchema.superRefine((value, context) => {
  const isPilot = value.offer_code === "guided_pilot";
  const isClub = value.offer_code === "operator_club_monthly" || value.offer_code === "operator_club_annual";
  if (isPilot !== (value.pilot_authorization_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Pilot authorization metadata mismatch" });
  }
  if ((value.offer_code === "self_paced" || isPilot) && value.recurring_policy_version !== undefined) {
    context.addIssue({ code: "custom", message: "One-time offer cannot carry recurring metadata" });
  }
  if (isClub && value.recurring_policy_version === undefined) {
    context.addIssue({ code: "custom", message: "Club metadata requires recurring policy" });
  }
});

export const SafeStripeMetadataSchema = StripeMetadataBaseSchema.partial().strict();

export const STRIPE_API_VERSION = "2026-06-24.dahlia" as const;

export const KNOWN_STRIPE_EVENT_OBJECT_TYPES = Object.freeze({
  "checkout.session.completed": "checkout.session",
  "checkout.session.async_payment_succeeded": "checkout.session",
  "checkout.session.async_payment_failed": "checkout.session",
  "checkout.session.expired": "checkout.session",
  "invoice.paid": "invoice",
  "invoice.payment_failed": "invoice",
  "invoice.payment_action_required": "invoice",
  "customer.subscription.created": "subscription",
  "customer.subscription.updated": "subscription",
  "customer.subscription.deleted": "subscription",
  "subscription_schedule.created": "subscription_schedule",
  "subscription_schedule.updated": "subscription_schedule",
  "subscription_schedule.released": "subscription_schedule",
  "subscription_schedule.completed": "subscription_schedule",
  "subscription_schedule.canceled": "subscription_schedule",
  "subscription_schedule.aborted": "subscription_schedule",
  "refund.created": "refund",
  "refund.updated": "refund",
  "refund.failed": "refund",
  "charge.dispute.created": "dispute",
  "charge.dispute.updated": "dispute",
  "charge.dispute.closed": "dispute",
} as const);

export const StripeEventEnvelopeSchema = z.object({
  eventId: OpaqueIdentifierSchema,
  eventType: OpaqueIdentifierSchema,
  knownEvent: z.boolean(),
  livemode: z.boolean(),
  objectTypeValid: z.boolean(),
  apiVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}\.[a-z][a-z0-9_-]{0,31}$/u).nullable(),
  providerCreatedAt: UtcMillisecondInstantSchema,
  dataObjectType: OpaqueIdentifierSchema,
  dataObjectId: OpaqueIdentifierSchema,
  receiverAccountId: OpaqueIdentifierSchema,
  eventAccount: OpaqueIdentifierSchema.nullable(),
  eventContext: OpaqueIdentifierSchema.nullable(),
  rawBodySha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict().superRefine((value, context) => {
  const expectedObject = KNOWN_STRIPE_EVENT_OBJECT_TYPES[
    value.eventType as keyof typeof KNOWN_STRIPE_EVENT_OBJECT_TYPES
  ];
  const knownEvent = expectedObject !== undefined;
  if (value.knownEvent !== knownEvent) {
    context.addIssue({ code: "custom", message: "Known-event classification mismatch" });
  }
  const objectTypeValid = expectedObject === undefined || expectedObject === value.dataObjectType;
  if (value.objectTypeValid !== objectTypeValid) {
    context.addIssue({ code: "custom", message: "Event object classification mismatch" });
  }
});

export const NormalizedStripeCheckoutSessionSchema = z.object({
  kind: z.literal("checkout_session"),
  providerSessionId: OpaqueIdentifierSchema,
  livemode: z.boolean(),
  mode: z.enum(["payment", "setup", "subscription"]),
  status: z.enum(["open", "complete", "expired"]),
  paymentStatus: z.enum(["paid", "unpaid", "no_payment_required"]),
  providerCustomerId: OpaqueIdentifierSchema.nullable(),
  paymentIntentId: OpaqueIdentifierSchema.nullable(),
  subscriptionId: OpaqueIdentifierSchema.nullable(),
  setupIntentId: OpaqueIdentifierSchema.nullable(),
  expiresAt: UtcMillisecondInstantSchema,
  metadata: SafeStripeMetadataSchema,
  lineItems: z.array(z.object({
    providerPriceId: OpaqueIdentifierSchema,
    quantity: z.literal(1),
  }).strict()).max(1),
}).strict();

export const NormalizedStripeSetupIntentSchema = z.object({
  kind: z.literal("setup_intent"),
  providerSetupIntentId: OpaqueIdentifierSchema,
  livemode: z.boolean(),
  status: z.enum([
    "requires_payment_method",
    "requires_confirmation",
    "requires_action",
    "processing",
    "canceled",
    "succeeded",
  ]),
  providerCustomerId: OpaqueIdentifierSchema.nullable(),
  providerPaymentMethodId: OpaqueIdentifierSchema.nullable(),
  paymentMethodCustomerId: OpaqueIdentifierSchema.nullable(),
  paymentMethodType: OpaqueIdentifierSchema.nullable(),
  metadata: SafeStripeMetadataSchema,
}).strict().superRefine((value, context) => {
  if (value.status === "succeeded" && (value.providerCustomerId === null
    || value.providerPaymentMethodId === null
    || value.paymentMethodCustomerId !== value.providerCustomerId
    || value.paymentMethodType === null)) {
    context.addIssue({ code: "custom", message: "Succeeded SetupIntent lacks attached reusable PaymentMethod proof" });
  }
});

const UsdMinorUnitSchema = z.number().int().nonnegative();
const NullableProviderIdSchema = OpaqueIdentifierSchema.nullable();
const NormalizedStripeLineItemSchema = z.object({
  providerPriceId: OpaqueIdentifierSchema,
  quantity: z.literal(1),
}).strict();

const TaxabilityReasonSchema = z.enum([
  "customer_exempt", "not_available", "not_collecting", "not_subject_to_tax", "not_supported",
  "portion_product_exempt", "portion_reduced_rated", "portion_standard_rated", "product_exempt",
  "product_exempt_holiday", "proportionally_rated", "reduced_rated", "reverse_charge",
  "standard_rated", "taxable_basis_reduced", "zero_rated",
]);

export const NormalizedStripeInvoiceSchema = z.object({
  kind: z.literal("invoice"),
  providerInvoiceId: OpaqueIdentifierSchema,
  livemode: z.boolean(),
  status: z.enum(["draft", "open", "paid", "uncollectible", "void"]),
  paid: z.boolean(),
  collectionMethod: z.enum(["charge_automatically", "send_invoice"]),
  currency: z.literal("usd"),
  amountDue: UsdMinorUnitSchema,
  amountPaid: UsdMinorUnitSchema,
  amountRemaining: UsdMinorUnitSchema,
  totalTaxAmount: UsdMinorUnitSchema,
  providerCustomerId: NullableProviderIdSchema,
  subscriptionId: NullableProviderIdSchema,
  paymentReferences: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("payment_intent"), providerPaymentId: OpaqueIdentifierSchema,
      status: z.enum(["open", "paid", "canceled"]), amountPaid: UsdMinorUnitSchema.nullable(),
      amountRequested: UsdMinorUnitSchema, currency: z.literal("usd"), paidAt: UtcMillisecondInstantSchema.nullable() }).strict(),
    z.object({ kind: z.literal("charge"), providerPaymentId: OpaqueIdentifierSchema,
      status: z.enum(["open", "paid", "canceled"]), amountPaid: UsdMinorUnitSchema.nullable(),
      amountRequested: UsdMinorUnitSchema, currency: z.literal("usd"), paidAt: UtcMillisecondInstantSchema.nullable() }).strict(),
  ])).max(20),
  metadata: SafeStripeMetadataSchema,
  lineItems: z.array(z.object({
    amount: UsdMinorUnitSchema,
    subtotal: UsdMinorUnitSchema,
    currency: z.literal("usd"),
    providerPriceId: OpaqueIdentifierSchema,
    quantity: z.literal(1),
    periodStart: UtcMillisecondInstantSchema,
    periodEnd: UtcMillisecondInstantSchema,
    taxes: z.array(z.object({
      amount: UsdMinorUnitSchema,
      taxBehavior: z.enum(["inclusive", "exclusive"]),
      taxabilityReason: TaxabilityReasonSchema,
      taxableAmount: UsdMinorUnitSchema.nullable(),
    }).strict()).max(25),
  }).strict()).min(1).max(20),
}).strict().superRefine((value, context) => {
  const paidReferences = value.paymentReferences.filter((payment) => payment.status === "paid");
  const paidReferenceTotal = paidReferences.reduce((sum, payment) => sum + (payment.amountPaid ?? 0), 0);
  if (value.paid && (value.status !== "paid" || paidReferences.length === 0
    || paidReferences.some((payment) => payment.amountPaid === null || payment.paidAt === null)
    || paidReferenceTotal !== value.amountPaid)) {
    context.addIssue({ code: "custom", message: "Paid Invoice lacks exact canonical payment proof" });
  }
});

export const NormalizedStripeSubscriptionSchema = z.object({
  kind: z.literal("subscription"),
  providerSubscriptionId: OpaqueIdentifierSchema,
  livemode: z.boolean(),
  status: z.enum(["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"]),
  providerCustomerId: NullableProviderIdSchema,
  cancelAtPeriodEnd: z.boolean(),
  canceledAt: UtcMillisecondInstantSchema.nullable(),
  metadata: SafeStripeMetadataSchema,
  lineItems: z.array(NormalizedStripeLineItemSchema.extend({
    currentPeriodStart: UtcMillisecondInstantSchema,
    currentPeriodEnd: UtcMillisecondInstantSchema,
  }).strict()).min(1).max(20),
}).strict();

export const NormalizedStripeSubscriptionScheduleSchema = z.object({
  kind: z.literal("subscription_schedule"),
  providerScheduleId: OpaqueIdentifierSchema,
  livemode: z.boolean(),
  status: z.enum(["not_started", "active", "completed", "released", "canceled"]),
  providerCustomerId: NullableProviderIdSchema,
  subscriptionId: NullableProviderIdSchema,
  metadata: SafeStripeMetadataSchema,
  phases: z.array(z.object({
    startsAt: UtcMillisecondInstantSchema,
    endsAt: UtcMillisecondInstantSchema,
    lineItems: z.array(NormalizedStripeLineItemSchema).min(1).max(20),
  }).strict()).max(10),
}).strict();

export const NormalizedStripeRefundSchema = z.object({
  kind: z.literal("refund"),
  providerRefundId: OpaqueIdentifierSchema,
  status: z.enum(["pending", "requires_action", "succeeded", "failed", "canceled"]),
  amount: UsdMinorUnitSchema,
  currency: z.literal("usd"),
  paymentIntentId: NullableProviderIdSchema,
  chargeId: NullableProviderIdSchema,
  metadata: SafeStripeMetadataSchema,
}).strict().superRefine((value, context) => {
  if (value.paymentIntentId === null && value.chargeId === null) {
    context.addIssue({ code: "custom", message: "Refund lacks canonical payment source" });
  }
});

export const NormalizedStripePaymentIntentSchema = z.object({
  kind: z.literal("payment_intent"),
  providerPaymentIntentId: OpaqueIdentifierSchema,
  livemode: z.boolean(),
  status: z.enum(["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"]),
  amount: UsdMinorUnitSchema,
  amountReceived: UsdMinorUnitSchema,
  currency: z.literal("usd"),
  providerCustomerId: NullableProviderIdSchema,
  latestChargeId: NullableProviderIdSchema,
  metadata: SafeStripeMetadataSchema,
}).strict();

export const NormalizedStripeChargeSchema = z.object({
  kind: z.literal("charge"),
  providerChargeId: OpaqueIdentifierSchema,
  livemode: z.boolean(),
  paid: z.boolean(),
  refunded: z.boolean(),
  disputed: z.boolean(),
  amount: UsdMinorUnitSchema,
  amountRefunded: UsdMinorUnitSchema,
  currency: z.literal("usd"),
  providerCustomerId: NullableProviderIdSchema,
  paymentIntentId: NullableProviderIdSchema,
  invoiceId: NullableProviderIdSchema,
}).strict();

export const NormalizedStripeDisputeSchema = z.object({
  kind: z.literal("dispute"),
  providerDisputeId: OpaqueIdentifierSchema,
  livemode: z.boolean(),
  status: z.enum([
    "warning_needs_response", "warning_under_review", "warning_closed", "needs_response",
    "under_review", "won", "lost", "prevented",
  ]),
  amount: UsdMinorUnitSchema,
  currency: z.literal("usd"),
  chargeId: OpaqueIdentifierSchema,
  paymentIntentId: NullableProviderIdSchema,
}).strict();

export const NormalizedStripeCanonicalObjectSchema = z.discriminatedUnion("kind", [
  NormalizedStripeCheckoutSessionSchema,
  NormalizedStripeSetupIntentSchema,
  NormalizedStripeInvoiceSchema,
  NormalizedStripeSubscriptionSchema,
  NormalizedStripeSubscriptionScheduleSchema,
  NormalizedStripeRefundSchema,
  NormalizedStripePaymentIntentSchema,
  NormalizedStripeChargeSchema,
  NormalizedStripeDisputeSchema,
]);

export const ClaimInitiateSelectionSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

export const SafeClaimPreviewSchema = z.object({
  state: z.literal("ready"),
  offerCode: PaidCommerceOfferCodeSchema,
  businessName: AccountNameSchema,
  expiresAt: UtcMillisecondInstantSchema,
}).strict();

export const OnboardingPatchSelectionSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  step: z.enum([
    "business_profile",
    "operations_profile",
    "priorities",
    "team",
    "delivery",
  ]),
  businessName: AccountNameSchema.optional(),
  website: z.string().url().max(2_048).refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  }).optional(),
  category: OpaqueIdentifierSchema.optional(),
  country: z.string().regex(/^[A-Z]{2}$/u).optional(),
  timezone: z.string().min(1).max(255).refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }).optional(),
  teamSizeBand: OpaqueIdentifierSchema.optional(),
  ownerRole: OpaqueIdentifierSchema.optional(),
  primaryGoal: OpaqueIdentifierSchema.optional(),
  toolSelections: z.array(OpaqueIdentifierSchema).max(25).optional(),
  priorities: z.array(z.string().min(1).max(255)).length(3).optional(),
  deliveryScheduleConfirmed: z.boolean().optional(),
}).strict();

export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[number];
export type CommerceOfferCode = z.infer<typeof CommerceOfferCodeSchema>;
export type StripeMetadata = z.infer<typeof StripeMetadataSchema>;
export type StripeEventEnvelope = z.infer<typeof StripeEventEnvelopeSchema>;
export type NormalizedStripeCheckoutSession = z.infer<typeof NormalizedStripeCheckoutSessionSchema>;
export type NormalizedStripeSetupIntent = z.infer<typeof NormalizedStripeSetupIntentSchema>;
export type NormalizedStripeCanonicalObject = z.infer<typeof NormalizedStripeCanonicalObjectSchema>;
