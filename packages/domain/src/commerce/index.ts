import { createHash } from "node:crypto";

export const COMMERCE_OFFER_CODES = Object.freeze([
  "scorecard",
  "self_paced",
  "guided_pilot",
  "operator_club_monthly",
  "operator_club_annual",
  "business_os",
] as const);

export type CommerceOfferCode = (typeof COMMERCE_OFFER_CODES)[number];

export type CatalogBindingInput = Readonly<{
  offerCode: string;
  role: string;
  currency: string;
  unitAmount: number;
  interval: string | null;
  intervalCount: number | null;
  productTaxCode: string;
  taxBehavior: string;
}>;

const requiredBindings = Object.freeze([
  { offerCode: "self_paced", role: "self_paced_once", unitAmount: 39_900, interval: null },
  { offerCode: "guided_pilot", role: "guided_pilot_once", unitAmount: 75_000, interval: null },
  { offerCode: "operator_club_monthly", role: "operator_club_monthly", unitAmount: 5_900, interval: "month" },
  { offerCode: "operator_club_annual", role: "operator_club_annual", unitAmount: 59_000, interval: "year" },
  { offerCode: "business_os", role: "business_os_setup", unitAmount: 99_900, interval: null },
  { offerCode: "business_os", role: "business_os_monthly", unitAmount: 19_900, interval: "month" },
] as const);

export type CatalogValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "INVALID_MONEY" | "INVALID_BINDING" | "REQUIRED_BINDING_MISSING" | "DUPLICATE_BINDING" }>;

export function validateCatalogBundle(bindings: readonly CatalogBindingInput[]): CatalogValidationResult {
  if (bindings.some((binding) => !Number.isSafeInteger(binding.unitAmount) || binding.unitAmount <= 0)) {
    return { ok: false, reason: "INVALID_MONEY" };
  }
  if (bindings.some((binding) => binding.currency !== "usd"
    || !/^txcd_[A-Za-z0-9._:-]+$/u.test(binding.productTaxCode)
    || !["inclusive", "exclusive"].includes(binding.taxBehavior)
    || (binding.interval === null ? binding.intervalCount !== null : binding.intervalCount !== 1))) {
    return { ok: false, reason: "INVALID_BINDING" };
  }
  const keys = bindings.map((binding) => `${binding.offerCode}:${binding.role}`);
  if (new Set(keys).size !== keys.length) return { ok: false, reason: "DUPLICATE_BINDING" };
  if (bindings.length !== requiredBindings.length) return { ok: false, reason: "REQUIRED_BINDING_MISSING" };
  for (const required of requiredBindings) {
    const binding = bindings.find((candidate) => candidate.offerCode === required.offerCode
      && candidate.role === required.role);
    if (binding === undefined) return { ok: false, reason: "REQUIRED_BINDING_MISSING" };
    if (binding.unitAmount !== required.unitAmount || binding.interval !== required.interval) {
      return { ok: false, reason: "INVALID_BINDING" };
    }
  }
  return { ok: true };
}

type CanonicalScalar = string | number | boolean | null;
interface CanonicalObject { readonly [key: string]: CanonicalValue }
type CanonicalValue = CanonicalScalar | readonly CanonicalValue[] | CanonicalObject;

function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, CanonicalValue>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

export type CatalogBindingFingerprintInput = Readonly<{
  active: boolean;
  catalogVersion: string;
  currency: "usd";
  environment: "test" | "staging" | "production";
  interval: "month" | "year" | null;
  intervalCount: 1 | null;
  livemode: boolean;
  offerCode: Exclude<CommerceOfferCode, "scorecard">;
  productId: string;
  productTaxCode: string;
  providerAccountId: string;
  providerPriceId: string;
  role: string;
  taxBehavior: "inclusive" | "exclusive";
  unitAmount: number;
  validFrom: string;
  validUntil: string | null;
}>;

const fingerprintKeys = Object.freeze([
  "active", "catalogVersion", "currency", "environment", "interval", "intervalCount",
  "livemode", "offerCode", "productId", "productTaxCode", "providerAccountId",
  "providerPriceId", "role", "taxBehavior", "unitAmount", "validFrom", "validUntil",
] as const);

export function catalogBindingFingerprint(binding: CatalogBindingFingerprintInput): string {
  const actualKeys = Object.keys(binding).sort();
  const expectedKeys = [...fingerprintKeys].sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("CATALOG_BINDING_INVALID");
  }
  const matchedBinding = requiredBindings.find((candidate) => candidate.offerCode === binding.offerCode
    && candidate.role === binding.role);
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
  const exactInstant = (value: unknown): number | null => {
    if (typeof value !== "string") return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed.getTime() : null;
  };
  const from = exactInstant(binding.validFrom);
  const until = binding.validUntil === null ? null : exactInstant(binding.validUntil);
  if (typeof binding.active !== "boolean" || typeof binding.livemode !== "boolean"
    || !["test", "staging", "production"].includes(binding.environment)
    || binding.currency !== "usd" || !["inclusive", "exclusive"].includes(binding.taxBehavior)
    || matchedBinding === undefined || matchedBinding.unitAmount !== binding.unitAmount
    || matchedBinding.interval !== binding.interval
    || binding.intervalCount !== (binding.interval === null ? null : 1)
    || !Number.isSafeInteger(binding.unitAmount) || binding.unitAmount <= 0
    || !identifier.test(binding.catalogVersion) || !/^txcd_[A-Za-z0-9._:-]+$/u.test(binding.productTaxCode)
    || !identifier.test(binding.role) || !/^acct_[A-Za-z0-9._:-]+$/u.test(binding.providerAccountId)
    || !/^prod_[A-Za-z0-9._:-]+$/u.test(binding.productId)
    || !/^price_[A-Za-z0-9._:-]+$/u.test(binding.providerPriceId)
    || from === null || (binding.validUntil !== null && (until === null || until <= from))) {
    throw new Error("CATALOG_BINDING_INVALID");
  }
  const canonical = Object.fromEntries(fingerprintKeys.map((key) => [key, binding[key]])) as Record<string, CanonicalValue>;
  return createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex");
}

export type OfferAvailabilityInput = Readonly<{
  offerCode: CommerceOfferCode;
  offerState: "draft" | "waitlist" | "enabled" | "paused";
  commerceHeld: boolean;
  catalogAttested: boolean;
  contentReady: boolean;
  pilotAuthorized: boolean;
  academyEligible: boolean;
  businessOsReady: boolean;
}>;

export type OfferAvailability = Readonly<{ state: "available" }>
  | Readonly<{
    state: "unavailable";
    reason: "OFFER_UNAVAILABLE" | "COMMERCE_HELD" | "CATALOG_MISMATCH"
      | "CURRICULUM_GATE_BLOCKED" | "AUTHORIZATION_EXPIRED"
      | "ACADEMY_REQUIRED" | "BUSINESS_OS_NOT_READY";
  }>;

export function evaluateOfferAvailability(input: OfferAvailabilityInput): OfferAvailability {
  if (!COMMERCE_OFFER_CODES.includes(input.offerCode)) {
    return { state: "unavailable", reason: "OFFER_UNAVAILABLE" };
  }
  if (input.offerState !== "enabled") return { state: "unavailable", reason: "OFFER_UNAVAILABLE" };
  if (input.offerCode !== "scorecard" && input.commerceHeld) return { state: "unavailable", reason: "COMMERCE_HELD" };
  if (input.offerCode !== "scorecard" && !input.catalogAttested) {
    return { state: "unavailable", reason: "CATALOG_MISMATCH" };
  }
  if ((input.offerCode === "self_paced" || input.offerCode === "guided_pilot") && !input.contentReady) {
    return { state: "unavailable", reason: "CURRICULUM_GATE_BLOCKED" };
  }
  if (input.offerCode === "guided_pilot" && !input.pilotAuthorized) {
    return { state: "unavailable", reason: "AUTHORIZATION_EXPIRED" };
  }
  if ((input.offerCode === "operator_club_monthly" || input.offerCode === "operator_club_annual")
    && !input.academyEligible) return { state: "unavailable", reason: "ACADEMY_REQUIRED" };
  if (input.offerCode === "business_os" && !input.businessOsReady) {
    return { state: "unavailable", reason: "BUSINESS_OS_NOT_READY" };
  }
  return { state: "available" };
}

export type BusinessOsPurchaseState =
  | Readonly<{ projection: "none" }>
  | Readonly<{ projection: "setup_paid_subscription_required"; setupSourceId: string }>
  | Readonly<{
    projection: "subscription_paid";
    setupSourceId: string;
    subscriptionSourceId: string;
    paidThroughAt: string;
  }>
  | Readonly<{
    projection: "subscription_terminal";
    setupSourceId: string;
    subscriptionSourceId: string;
  }>;

export type BusinessOsPurchaseEvent =
  | Readonly<{ type: "setup_payment_paid"; sourceId: string; paidAt: Date }>
  | Readonly<{
    type: "recurring_invoice_paid";
    lifecycle: "initial";
    sourceId: string;
    occurredAt: Date;
    paidThroughAt: Date;
  }>
  | Readonly<{
    type: "recurring_invoice_paid";
    lifecycle: "renewal" | "recovery";
    sourceId: string;
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>;

function exactInstant(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("COMMERCE_TIME_INVALID");
  return value.toISOString();
}

function instantMillis(value: string): number {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("COMMERCE_TIME_INVALID");
  }
  return parsed.getTime();
}

export function reduceBusinessOsPurchase(state: BusinessOsPurchaseState, event: BusinessOsPurchaseEvent) {
  if (event.type !== "setup_payment_paid" && event.type !== "recurring_invoice_paid") {
    throw new Error("BUSINESS_OS_EVENT_INVALID");
  }
  if (typeof event.sourceId !== "string" || event.sourceId.length < 1) throw new Error("COMMERCE_SOURCE_INVALID");
  if (event.type === "recurring_invoice_paid"
    && !["initial", "renewal", "recovery"].includes(event.lifecycle)) {
    throw new Error("BUSINESS_OS_EVENT_INVALID");
  }
  if (event.type === "setup_payment_paid") {
    const occurredAt = exactInstant(event.paidAt);
    if (state.projection !== "none") throw new Error("BUSINESS_OS_SETUP_EXISTS");
    return Object.freeze({
      projection: "setup_paid_subscription_required" as const,
      setupSourceId: event.sourceId,
      command: Object.freeze({
        kind: "record_business_os_setup_purchase" as const,
        sourceId: event.sourceId,
        purchasedAt: occurredAt,
      }),
    });
  }
  const paidThroughAt = exactInstant(event.paidThroughAt);
  if (state.projection === "none") throw new Error("BUSINESS_OS_SETUP_REQUIRED");
  if (state.projection === "subscription_terminal") throw new Error("BUSINESS_OS_SOURCE_TERMINAL");
  if (state.projection === "subscription_paid" && state.subscriptionSourceId !== event.sourceId) {
    throw new Error("BUSINESS_OS_SUBSCRIPTION_CONFLICT");
  }
  if ((state.projection === "setup_paid_subscription_required") !== (event.lifecycle === "initial")) {
    throw new Error("BUSINESS_OS_LIFECYCLE_INVALID");
  }
  const command = event.lifecycle === "initial"
    ? (() => {
      const startsAt = exactInstant(event.occurredAt);
      if (instantMillis(startsAt) >= instantMillis(paidThroughAt)) {
        throw new Error("COMMERCE_INTERVAL_INVALID");
      }
      return Object.freeze({
        kind: "fulfill_product" as const,
        sourceKind: "subscription" as const,
        sourceId: event.sourceId,
        offerCode: "business_os" as const,
        startsAt,
        endsAt: paidThroughAt,
      });
    })()
    : Object.freeze({
      kind: event.lifecycle === "renewal" ? "renew_business_os" as const : "recover_business_os_payment" as const,
      sourceRegistryId: event.sourceRegistryId,
      paidThroughAt,
    });
  if (event.lifecycle !== "initial" && state.projection === "subscription_paid"
    && instantMillis(paidThroughAt) <= instantMillis(state.paidThroughAt)) {
    throw new Error("COMMERCE_INTERVAL_INVALID");
  }
  return Object.freeze({
    projection: "subscription_paid" as const,
    setupSourceId: state.setupSourceId,
    subscriptionSourceId: event.sourceId,
    paidThroughAt,
    command,
  });
}

export type OrdinaryPaidOfferEvent = Readonly<{
  offerCode: "self_paced" | "guided_pilot" | "operator_club_monthly" | "operator_club_annual";
  sourceId: string;
  lifecycle: "initial" | "renewal" | "recovery";
  sourceRegistryId?: string;
  occurredAt: Date;
  academySourceRegistryId?: string;
  paidThroughAt?: Date;
}>;

export function classifyPaidOfferEvent(input: OrdinaryPaidOfferEvent) {
  const occurredAt = exactInstant(input.occurredAt);
  if (input.sourceId.length < 1) throw new Error("COMMERCE_SOURCE_INVALID");
  if ((input.offerCode as string) === "scorecard") throw new Error("COMMERCE_OFFER_NOT_PAID");
  if ((input.offerCode as string) === "business_os") throw new Error("BUSINESS_OS_STAGE_REQUIRED");
  if (!["self_paced", "guided_pilot", "operator_club_monthly", "operator_club_annual"]
    .includes(input.offerCode)) throw new Error("COMMERCE_OFFER_INVALID");
  if (!["initial", "renewal", "recovery"].includes(input.lifecycle)) {
    throw new Error("COMMERCE_LIFECYCLE_INVALID");
  }
  if (input.offerCode === "self_paced" || input.offerCode === "guided_pilot") {
    if (input.lifecycle !== "initial") throw new Error("COMMERCE_LIFECYCLE_INVALID");
    return Object.freeze({
      kind: "fulfill_product" as const,
      offerCode: input.offerCode,
      sourceKind: "purchase" as const,
      sourceId: input.sourceId,
      startsAt: occurredAt,
    });
  }
  if (input.academySourceRegistryId === undefined || input.academySourceRegistryId.length < 1
    || input.paidThroughAt === undefined) throw new Error("ACADEMY_SOURCE_REQUIRED");
  const paidThroughAt = exactInstant(input.paidThroughAt);
  if (input.lifecycle === "initial" && instantMillis(occurredAt) >= instantMillis(paidThroughAt)) {
    throw new Error("COMMERCE_INTERVAL_INVALID");
  }
  if (input.lifecycle !== "initial") {
    if (input.sourceRegistryId === undefined || input.sourceRegistryId.length < 1) {
      throw new Error("COMMERCE_SOURCE_REGISTRY_REQUIRED");
    }
    return Object.freeze({
      kind: "recover_club_payment" as const,
      lifecycle: input.lifecycle,
      sourceRegistryId: input.sourceRegistryId,
      paidThroughAt,
    });
  }
  return Object.freeze({
    kind: "fulfill_product" as const,
    offerCode: input.offerCode,
    sourceKind: "subscription" as const,
    sourceId: input.sourceId,
    academySourceRegistryId: input.academySourceRegistryId,
    startsAt: occurredAt,
    endsAt: paidThroughAt,
  });
}
