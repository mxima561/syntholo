import { createHash } from "node:crypto";
import { canonicalizeAccountName } from "@syntholo/contracts/member-dashboard";
import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../unit-of-work.js";
import type {
  TransactionGuard,
  TrustedTransactionMetadata,
} from "./context.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const hash = /^[0-9a-f]{64}$/u;
const providerOwner = /^[A-Za-z0-9._:-]{1,255}$/u;
const effectKind = /^[a-z][a-z0-9_.]{0,63}$/u;
const recurringStates = new Set<RecurringState>([
  "provider_call_pending",
  "checkout_open",
  "setup_succeeded",
  "schedule_pending",
  "subscription_pending",
  "active",
  "grace",
  "cancellation_pending",
  "terminal_cancelled",
  "terminal_expired",
  "terminal_refunded",
  "terminal_revoked",
  "abandoned",
]);

const state = new WeakMap<TransactionCommerceRepository, Readonly<{
  transaction: DatabaseTransaction;
  metadata: TrustedTransactionMetadata;
  guard: TransactionGuard;
}>>();

function exactInstant(value: Date): Date {
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(23) !== "Z") {
    throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
  }
  return new Date(value);
}

function inputHash(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function rowObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
  }
  return value as Record<string, unknown>;
}

function rowUuid(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !uuid.test(value)) {
    throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
  }
  return value;
}

function rowText(
  row: Record<string, unknown>,
  key: string,
  pattern: RegExp = providerOwner,
): string {
  const value = row[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
  }
  return value;
}

function rowInstant(row: Record<string, unknown>, key: string): Date {
  const value = row[key];
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())
    || value.toISOString().slice(23) !== "Z") {
    throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
  }
  return new Date(value);
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > 1000) {
    throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
  }
  return value;
}

const onboardingSteps = new Set([
  "business", "tools", "priorities", "team", "delivery", "complete",
]);

function onboardingTools(value: unknown): Readonly<{
  crm: readonly string[];
  scheduling: readonly string[];
  email: readonly string[];
}> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, ["crm", "scheduling", "email"])) {
    throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
  }
  const source = value as Record<string, unknown>;
  const result = {} as Record<string, readonly string[]>;
  for (const key of ["crm", "scheduling", "email"] as const) {
    const entries = source[key];
    if (!Array.isArray(entries) || entries.length > 20
      || entries.some((entry) => typeof entry !== "string"
        || Buffer.byteLength(entry, "utf8") < 1
        || Buffer.byteLength(entry, "utf8") > 128)
      || new Set(entries).size !== entries.length) {
      throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
    }
    result[key] = Object.freeze([...entries]) as readonly string[];
  }
  return Object.freeze(result) as Readonly<{
    crm: readonly string[];
    scheduling: readonly string[];
    email: readonly string[];
  }>;
}

export type RecurringFamily = "operator_club" | "business_os";
export type RecurringState =
  | "provider_call_pending"
  | "checkout_open"
  | "setup_succeeded"
  | "schedule_pending"
  | "subscription_pending"
  | "active"
  | "grace"
  | "cancellation_pending"
  | "terminal_cancelled"
  | "terminal_expired"
  | "terminal_refunded"
  | "terminal_revoked"
  | "abandoned";
export type RecurringOfferCode =
  | "operator_club_monthly"
  | "operator_club_annual"
  | "business_os";
export type CommerceOfferCode =
  | "scorecard"
  | "self_paced"
  | "guided_pilot"
  | "operator_club_monthly"
  | "operator_club_annual"
  | "business_os";
export type CommerceEnvironment = "test" | "staging" | "production";
export type CommercePriceRole =
  | "self_paced_once"
  | "guided_pilot_once"
  | "operator_club_monthly"
  | "operator_club_annual"
  | "business_os_setup"
  | "business_os_monthly"
  | "gate5_validation";
export type ProviderEventOutcome =
  | "processed"
  | "failed_retryable"
  | "failed_terminal";
export type ProviderEventRecordStatus =
  | "received"
  | "processing"
  | ProviderEventOutcome;

export type ProviderEventClaim = Readonly<{
  receiptId: string;
  providerEventId: string;
  eventType: string;
  livemode: boolean;
  apiVersion: string;
  providerCreatedAt: Date;
  dataObjectType: string;
  dataObjectId: string;
  receiverStripeAccountId: string;
  eventAccount: null;
  eventContext: null;
  rawBodySha256: string;
  receivedAt: Date;
  leaseToken: string;
  leaseGeneration: number;
  leaseExpiresAt: Date;
}>;

export class TransactionCommerceRepository {
  constructor(
    transaction: DatabaseTransaction,
    metadata: TrustedTransactionMetadata,
    guard: TransactionGuard,
  ) {
    state.set(this, Object.freeze({ transaction, metadata, guard }));
    Object.freeze(this);
  }

  stageCatalogVersion(input: Readonly<{
    offerCode: CommerceOfferCode;
    version: string;
    policyVersions: Readonly<Record<string, string>>;
    contentReadinessHash: string | null;
    catalogHash: string;
  }>): Promise<Readonly<{
    replayed: boolean;
    catalogVersionId: string;
    state: "draft" | "published" | "retired";
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const policyEntries = Object.entries(input.policyVersions);
      const policySafe = Object.getPrototypeOf(input.policyVersions) === Object.prototype
        && policyEntries.length > 0
        && policyEntries.every(([key, value]) =>
          /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(key)
          && typeof value === "string"
          && Buffer.byteLength(value, "utf8") >= 1
          && Buffer.byteLength(value, "utf8") <= 255);
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null || !policySafe
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.version)
        || (input.contentReadinessHash !== null
          && !hash.test(input.contentReadinessHash))
        || !hash.test(input.catalogHash)
        || Buffer.byteLength(JSON.stringify(input.policyVersions), "utf8") > 4096) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_stage_catalog_version_v1(
          ${input.offerCode},${input.version},${input.policyVersions},
          ${input.contentReadinessHash},${input.catalogHash},
          ${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, ["replayed", "catalog_version_id", "state"])
        || typeof row.replayed !== "boolean"
        || !["draft", "published", "retired"].includes(String(row.state))) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        catalogVersionId: rowUuid(row, "catalog_version_id"),
        state: row.state as "draft" | "published" | "retired",
      });
    });
  }

  stagePriceBinding(input: Readonly<{
    catalogVersionId: string;
    offerCode: CommerceOfferCode;
    environment: CommerceEnvironment;
    stripeAccountId: string;
    stripeProductId: string;
    stripePriceId: string;
    priceRole: CommercePriceRole;
    productTaxCode: string;
    currency: "usd";
    unitAmount: number;
    recurringInterval: "month" | "year" | null;
    intervalCount: 1 | null;
    taxBehavior: "inclusive" | "exclusive";
    verifiedAt: Date;
  }>): Promise<Readonly<{ replayed: boolean; priceBindingId: string }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const verifiedAt = exactInstant(input.verifiedAt);
      const providerId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
      const intervalSafe = (input.recurringInterval === null
          && input.intervalCount === null)
        || ((input.recurringInterval === "month" || input.recurringInterval === "year")
          && input.intervalCount === 1);
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null || !uuid.test(input.catalogVersionId)
        || !providerId.test(input.stripeAccountId)
        || !/^prod_[A-Za-z0-9._:-]+$/u.test(input.stripeProductId)
        || !/^price_[A-Za-z0-9._:-]+$/u.test(input.stripePriceId)
        || !/^txcd_[A-Za-z0-9._:-]+$/u.test(input.productTaxCode)
        || input.currency !== "usd" || !Number.isInteger(input.unitAmount)
        || input.unitAmount <= 0 || !intervalSafe
        || verifiedAt > context.metadata.clock.now()) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const fingerprint = createHash("sha256").update([
        "commerce-price-binding.v1", input.offerCode, input.environment,
        input.stripeAccountId, input.stripeProductId, input.stripePriceId,
        input.priceRole, input.productTaxCode, input.currency,
        String(input.unitAmount), input.recurringInterval ?? "-",
        input.intervalCount === null ? "0" : String(input.intervalCount),
        input.taxBehavior, "1",
      ].join("\n"), "utf8").digest("hex");
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_stage_price_binding_v1(
          ${input.catalogVersionId},${input.offerCode},${input.environment},
          ${input.stripeAccountId},${input.stripeProductId},${input.stripePriceId},
          ${input.priceRole},${input.productTaxCode},${input.currency},
          ${input.unitAmount},${input.recurringInterval},${input.intervalCount},
          ${input.taxBehavior},${fingerprint},${verifiedAt},
          ${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, ["replayed", "price_binding_id"])
        || typeof row.replayed !== "boolean") {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        priceBindingId: rowUuid(row, "price_binding_id"),
      });
    });
  }

  publishCatalogVersion(input: Readonly<{
    catalogVersionId: string;
    offerCode: CommerceOfferCode;
    environment: CommerceEnvironment;
  }>): Promise<Readonly<{
    replayed: boolean;
    catalogVersionId: string;
    state: "published";
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null
        || !uuid.test(input.catalogVersionId)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_publish_catalog_version_v1(
          ${input.catalogVersionId},${input.offerCode},${input.environment},
          ${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, ["replayed", "catalog_version_id", "state"])
        || typeof row.replayed !== "boolean" || row.state !== "published") {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        catalogVersionId: rowUuid(row, "catalog_version_id"),
        state: "published",
      });
    });
  }

  stageCheckoutAction(input: Readonly<{
    authorizationId: string;
    requestFingerprint: string;
  }>): Promise<Readonly<{
    replayed: boolean;
    actionId: string;
    providerIdempotencyKey: string;
    status: "pending" | "in_flight" | "succeeded" | "failed_retryable"
      | "failed_terminal" | "ambiguous";
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      if (context.metadata.actor.kind !== "system"
        || (context.metadata.accountId !== null
          && !uuid.test(context.metadata.accountId))
        || !uuid.test(input.authorizationId)
        || !hash.test(input.requestFingerprint)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_stage_checkout_action_v1(
          ${input.authorizationId},${input.requestFingerprint},
          ${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      const statuses = new Set([
        "pending", "in_flight", "succeeded", "failed_retryable",
        "failed_terminal", "ambiguous",
      ]);
      if (!exactKeys(row, [
        "replayed", "action_id", "provider_idempotency_key", "status",
      ]) || typeof row.replayed !== "boolean"
        || typeof row.status !== "string" || !statuses.has(row.status)) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      const actionId = rowUuid(row, "action_id");
      const providerIdempotencyKey = rowText(
        row,
        "provider_idempotency_key",
        /^(?:checkout:[0-9a-f-]{36}|business_os_setup_checkout:[0-9a-f-]{36})$/u,
      );
      if (providerIdempotencyKey !== `checkout:${input.authorizationId}`
        && providerIdempotencyKey !== `business_os_setup_checkout:${actionId}`) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        actionId,
        providerIdempotencyKey,
        status: row.status as "pending" | "in_flight" | "succeeded"
          | "failed_retryable" | "failed_terminal" | "ambiguous",
      });
    });
  }

  recordCheckoutSession(input: Readonly<{
    actionId: string;
    requestFingerprint: string;
    attempt: number;
    providerSessionId: string;
    providerCustomerId: string | null;
    mode: "payment" | "setup" | "subscription";
    paymentStatus: "paid" | "unpaid" | "no_payment_required";
    checkoutUrlCiphertext: Uint8Array;
    checkoutUrlNonce: Uint8Array;
    checkoutUrlTag: Uint8Array;
    checkoutUrlKeyId: string;
    expiresAt: Date;
  }>): Promise<Readonly<{
    replayed: boolean;
    checkoutSessionId: string;
    status: "open";
    paymentStatus: "paid" | "unpaid" | "no_payment_required";
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const expiresAt = exactInstant(input.expiresAt);
      if (context.metadata.actor.kind !== "system"
        || (context.metadata.accountId !== null
          && !uuid.test(context.metadata.accountId))
        || !uuid.test(input.actionId) || !hash.test(input.requestFingerprint)
        || !Number.isInteger(input.attempt) || input.attempt < 1
        || !/^cs_[A-Za-z0-9._:-]+$/u.test(input.providerSessionId)
        || (input.providerCustomerId !== null
          && !/^cus_[A-Za-z0-9._:-]+$/u.test(input.providerCustomerId))
        || !["payment", "setup", "subscription"].includes(input.mode)
        || !["paid", "unpaid", "no_payment_required"].includes(input.paymentStatus)
        || !(input.checkoutUrlCiphertext instanceof Uint8Array)
        || input.checkoutUrlCiphertext.byteLength < 1
        || input.checkoutUrlCiphertext.byteLength > 4096
        || !(input.checkoutUrlNonce instanceof Uint8Array)
        || input.checkoutUrlNonce.byteLength !== 12
        || !(input.checkoutUrlTag instanceof Uint8Array)
        || input.checkoutUrlTag.byteLength !== 16
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.checkoutUrlKeyId)
        || expiresAt <= context.metadata.clock.now()) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_record_checkout_session_v1(
          ${input.actionId},${input.requestFingerprint},${input.attempt},
          ${input.providerSessionId},
          ${input.providerCustomerId},${input.mode},${input.paymentStatus},
          ${Buffer.from(input.checkoutUrlCiphertext)},
          ${Buffer.from(input.checkoutUrlNonce)},${Buffer.from(input.checkoutUrlTag)},
          ${input.checkoutUrlKeyId},${expiresAt},${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, [
        "replayed", "checkout_session_id", "status", "payment_status",
      ]) || typeof row.replayed !== "boolean" || row.status !== "open"
        || typeof row.payment_status !== "string"
        || !["paid", "unpaid", "no_payment_required"].includes(row.payment_status)) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        checkoutSessionId: rowUuid(row, "checkout_session_id"),
        status: "open" as const,
        paymentStatus: row.payment_status as "paid" | "unpaid" | "no_payment_required",
      });
    });
  }

  beginCheckoutAction(input: Readonly<{
    actionId: string;
    requestFingerprint: string;
  }>): Promise<Readonly<{
    replayed: false;
    actionId: string;
    providerIdempotencyKey: string;
    attempt: number;
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      if (context.metadata.actor.kind !== "system"
        || (context.metadata.accountId !== null
          && !uuid.test(context.metadata.accountId))
        || !uuid.test(input.actionId) || !hash.test(input.requestFingerprint)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_begin_checkout_action_v1(
          ${input.actionId},${input.requestFingerprint},${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, [
        "replayed", "action_id", "provider_idempotency_key", "attempt",
      ]) || row.replayed !== false || typeof row.attempt !== "number"
        || !Number.isInteger(row.attempt) || row.attempt < 1) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      const actionId = rowUuid(row, "action_id");
      if (actionId !== input.actionId) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: false as const,
        actionId,
        providerIdempotencyKey: rowText(
          row,
          "provider_idempotency_key",
          /^(?:checkout|business_os_setup_checkout):[0-9a-f-]{36}$/u,
        ),
        attempt: row.attempt,
      });
    });
  }

  finishCheckoutAction(input: Readonly<{
    actionId: string;
    requestFingerprint: string;
    attempt: number;
    outcome: "failed_retryable" | "failed_terminal" | "ambiguous";
    errorCode: string;
  }>): Promise<Readonly<{
    replayed: boolean;
    status: "failed_retryable" | "failed_terminal" | "ambiguous";
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      if (context.metadata.actor.kind !== "system"
        || (context.metadata.accountId !== null
          && !uuid.test(context.metadata.accountId))
        || !uuid.test(input.actionId) || !hash.test(input.requestFingerprint)
        || !Number.isInteger(input.attempt) || input.attempt < 1
        || !["failed_retryable", "failed_terminal", "ambiguous"]
          .includes(input.outcome)
        || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(input.errorCode)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_finish_checkout_action_v1(
          ${input.actionId},${input.requestFingerprint},${input.attempt},
          ${input.outcome},${input.errorCode},${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, ["replayed", "status"])
        || typeof row.replayed !== "boolean" || row.status !== input.outcome) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({ replayed: row.replayed, status: input.outcome });
    });
  }

  reservePublicBusinessOsSetup(input: Readonly<{
    principalId: string; idempotencyKey: string;
    environment: CommerceEnvironment; receiverStripeAccountId: string;
    catalogVersionId: string; priceBindingId: string;
    purchaserGuardHmac: Uint8Array; semanticRequestHmac: Uint8Array;
    equalityKeyId: string; commandDigestKeyId: string;
    contactCiphertext: Uint8Array; contactNonce: Uint8Array; contactTag: Uint8Array;
    contactKeyId: string; businessNameCiphertext: Uint8Array;
    businessNameNonce: Uint8Array; businessNameTag: Uint8Array;
    businessNameKeyId: string; businessNameContentHash: string;
    accountNameSchemaVersion: string;
    requestHash: string; integrationIdentifier: string;
    policyVersions: Readonly<Record<string, string>>; expiresAt: Date;
  }>): Promise<Readonly<{
    replayed: boolean; publicIntentId: string; authorizationId: string;
    actionId: string; providerIdempotencyKey: string;
    state: string;
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const expiresAt = exactInstant(input.expiresAt);
      const key = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
      const bytes = (value: Uint8Array, length?: number, max = 4096) =>
        value instanceof Uint8Array && (length === undefined
          ? value.byteLength >= 1 && value.byteLength <= max
          : value.byteLength === length);
      const policyEntries = Object.entries(input.policyVersions);
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null
        || !key.test(input.principalId)
        || !/^[A-Za-z0-9._~-]{16,128}$/u.test(input.idempotencyKey)
        || !providerOwner.test(input.receiverStripeAccountId)
        || !uuid.test(input.catalogVersionId) || !uuid.test(input.priceBindingId)
        || !bytes(input.purchaserGuardHmac, 32)
        || !bytes(input.semanticRequestHmac, 32)
        || !key.test(input.equalityKeyId) || !key.test(input.commandDigestKeyId)
        || !bytes(input.contactCiphertext) || !bytes(input.contactNonce, 12)
        || !bytes(input.contactTag, 16) || !key.test(input.contactKeyId)
        || !bytes(input.businessNameCiphertext) || !bytes(input.businessNameNonce, 12)
        || !bytes(input.businessNameTag, 16) || !key.test(input.businessNameKeyId)
        || !hash.test(input.businessNameContentHash)
        || input.accountNameSchemaVersion !== "account_name_v1"
        || !hash.test(input.requestHash)
        || !/^syntholo_[A-Za-z]{8}$/u.test(input.integrationIdentifier)
        || Object.getPrototypeOf(input.policyVersions) !== Object.prototype
        || policyEntries.length < 1
        || policyEntries.some(([name, value]) => !key.test(name)
          || typeof value !== "string" || !key.test(value))
        || Buffer.byteLength(JSON.stringify(input.policyVersions), "utf8") > 4096
        || expiresAt <= context.metadata.clock.now()) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_reserve_public_bos_setup_v1(
          ${input.principalId},${input.idempotencyKey},${input.environment},
          ${input.receiverStripeAccountId},${input.catalogVersionId},
          ${input.priceBindingId},${Buffer.from(input.purchaserGuardHmac)},
          ${Buffer.from(input.semanticRequestHmac)},${input.equalityKeyId},
          ${input.commandDigestKeyId},${Buffer.from(input.contactCiphertext)},
          ${Buffer.from(input.contactNonce)},${Buffer.from(input.contactTag)},
          ${input.contactKeyId},${Buffer.from(input.businessNameCiphertext)},
          ${Buffer.from(input.businessNameNonce)},${Buffer.from(input.businessNameTag)},
          ${input.businessNameKeyId},${input.businessNameContentHash},
          ${input.accountNameSchemaVersion},
          ${input.requestHash},${input.integrationIdentifier},${input.policyVersions},
          ${expiresAt},${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, ["replayed", "public_intent_id", "authorization_id",
        "action_id", "provider_idempotency_key", "state"])
        || typeof row.replayed !== "boolean" || typeof row.state !== "string") {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      const actionId = rowUuid(row, "action_id");
      return Object.freeze({
        replayed: row.replayed,
        publicIntentId: rowUuid(row, "public_intent_id"),
        authorizationId: rowUuid(row, "authorization_id"), actionId,
        providerIdempotencyKey: rowText(row, "provider_idempotency_key",
          /^business_os_setup_checkout:[0-9a-f-]{36}$/u),
        state: row.state,
      });
    });
  }

  reservePublicSelfPacedCheckout(input: Readonly<{
    principalId: string;
    idempotencyKey: string;
    environment: CommerceEnvironment;
    receiverStripeAccountId: string;
    catalogVersionId: string;
    priceBindingId: string;
    contactEmailFingerprint: Uint8Array;
    contactCiphertext: Uint8Array;
    contactNonce: Uint8Array;
    contactTag: Uint8Array;
    contactKeyId: string;
    businessNameCiphertext: Uint8Array;
    businessNameNonce: Uint8Array;
    businessNameTag: Uint8Array;
    businessNameKeyId: string;
    businessNameContentHash: string;
    accountNameSchemaVersion: "account_name_v1";
    requestHash: string;
    integrationIdentifier: string;
    policyVersions: Readonly<{
      terms: string;
      privacy: string;
      refund: string;
    }>;
    expiresAt: Date;
  }>): Promise<Readonly<{
    replayed: boolean;
    authorizationId: string;
    actionId: string;
    providerIdempotencyKey: string;
    state: "provider_call_pending";
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const expiresAt = exactInstant(input.expiresAt);
      const boundedKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
      const exactBytes = (value: Uint8Array, length?: number) =>
        value instanceof Uint8Array && (length === undefined
          ? value.byteLength >= 1 && value.byteLength <= 4096
          : value.byteLength === length);
      const policyKeys = Object.keys(input.policyVersions).sort();
      const policiesSafe = Object.getPrototypeOf(input.policyVersions) === Object.prototype
        && policyKeys.join("\0") === "privacy\0refund\0terms"
        && Object.values(input.policyVersions).every((value) =>
          typeof value === "string" && Buffer.byteLength(value, "utf8") >= 1
          && Buffer.byteLength(value, "utf8") <= 255)
        && Buffer.byteLength(JSON.stringify(input.policyVersions), "utf8") <= 4096;
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null
        || !boundedKey.test(input.principalId)
        || !/^[A-Za-z0-9._~-]{16,128}$/u.test(input.idempotencyKey)
        || !providerOwner.test(input.receiverStripeAccountId)
        || !uuid.test(input.catalogVersionId) || !uuid.test(input.priceBindingId)
        || !exactBytes(input.contactEmailFingerprint, 32)
        || !exactBytes(input.contactCiphertext)
        || !exactBytes(input.contactNonce, 12) || !exactBytes(input.contactTag, 16)
        || !boundedKey.test(input.contactKeyId)
        || !exactBytes(input.businessNameCiphertext)
        || !exactBytes(input.businessNameNonce, 12)
        || !exactBytes(input.businessNameTag, 16)
        || !boundedKey.test(input.businessNameKeyId)
        || !hash.test(input.businessNameContentHash)
        || input.accountNameSchemaVersion !== "account_name_v1"
        || !hash.test(input.requestHash)
        || !/^syntholo_[A-Za-z]{8}$/u.test(input.integrationIdentifier)
        || !policiesSafe || expiresAt <= context.metadata.clock.now()
        || expiresAt.getTime() > context.metadata.clock.now().getTime() + 86_400_000) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_reserve_public_self_paced_v1(
          ${input.principalId},${input.idempotencyKey},${input.environment},
          ${input.receiverStripeAccountId},${input.catalogVersionId},
          ${input.priceBindingId},${Buffer.from(input.contactEmailFingerprint)},
          ${Buffer.from(input.contactCiphertext)},${Buffer.from(input.contactNonce)},
          ${Buffer.from(input.contactTag)},${input.contactKeyId},
          ${Buffer.from(input.businessNameCiphertext)},
          ${Buffer.from(input.businessNameNonce)},${Buffer.from(input.businessNameTag)},
          ${input.businessNameKeyId},${input.businessNameContentHash},
          ${input.accountNameSchemaVersion},${input.requestHash},
          ${input.integrationIdentifier},${input.policyVersions},${expiresAt},
          ${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, [
        "replayed", "authorization_id", "action_id",
        "provider_idempotency_key", "state",
      ]) || typeof row.replayed !== "boolean"
        || row.state !== "provider_call_pending") {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      const authorizationId = rowUuid(row, "authorization_id");
      const providerIdempotencyKey = rowText(
        row,
        "provider_idempotency_key",
        /^checkout:[0-9a-f-]{36}$/u,
      );
      if (providerIdempotencyKey !== `checkout:${authorizationId}`) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        authorizationId,
        actionId: rowUuid(row, "action_id"),
        providerIdempotencyKey,
        state: "provider_call_pending" as const,
      });
    });
  }

  reserveExistingBusinessOsSetup(input: Readonly<{
    membershipId: string;
    idempotencyKey: string;
    environment: CommerceEnvironment;
    receiverStripeAccountId: string;
    catalogVersionId: string;
    priceBindingId: string;
    requestHash: string;
    integrationIdentifier: string;
    policyVersions: Readonly<Record<string, string>>;
    expiresAt: Date;
  }>): Promise<Readonly<{
    replayed: boolean;
    setupEpochId: string;
    authorizationId: string;
    actionId: string;
    providerIdempotencyKey: string;
    state: "checkout_create_pending" | "checkout_open"
      | "async_payment_pending" | "paid" | "refund_pending" | "dispute_open";
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const accountId = context.metadata.accountId;
      const expiresAt = exactInstant(input.expiresAt);
      const policyEntries = Object.entries(input.policyVersions);
      const policySafe = Object.getPrototypeOf(input.policyVersions) === Object.prototype
        && policyEntries.length > 0
        && policyEntries.every(([key, value]) =>
          /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(key)
          && typeof value === "string"
          && Buffer.byteLength(value, "utf8") >= 1
          && Buffer.byteLength(value, "utf8") <= 255)
        && Buffer.byteLength(JSON.stringify(input.policyVersions), "utf8") <= 4096;
      if (context.metadata.actor.kind !== "system" || accountId === null
        || !uuid.test(accountId) || !uuid.test(input.membershipId)
        || !/^[A-Za-z0-9._~-]{16,128}$/u.test(input.idempotencyKey)
        || !providerOwner.test(input.receiverStripeAccountId)
        || !uuid.test(input.catalogVersionId) || !uuid.test(input.priceBindingId)
        || !hash.test(input.requestHash)
        || !/^syntholo_[A-Za-z]{8}$/u.test(input.integrationIdentifier)
        || !policySafe || expiresAt <= context.metadata.clock.now()
        || expiresAt.getTime() > context.metadata.clock.now().getTime() + 86_400_000) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_reserve_existing_bos_setup_v1(
          ${accountId},${input.membershipId},${input.idempotencyKey},
          ${input.environment},${input.receiverStripeAccountId},
          ${input.catalogVersionId},${input.priceBindingId},${input.requestHash},
          ${input.integrationIdentifier},${input.policyVersions},${expiresAt},
          ${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      const states = new Set([
        "checkout_create_pending", "checkout_open", "async_payment_pending",
        "paid", "refund_pending", "dispute_open",
      ]);
      if (!exactKeys(row, [
        "replayed", "setup_epoch_id", "authorization_id", "action_id",
        "provider_idempotency_key", "state",
      ]) || typeof row.replayed !== "boolean"
        || typeof row.state !== "string" || !states.has(row.state)) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      const authorizationId = rowUuid(row, "authorization_id");
      const actionId = rowUuid(row, "action_id");
      const providerIdempotencyKey = rowText(
        row,
        "provider_idempotency_key",
        /^checkout:[0-9a-f-]{36}$/u,
      );
      if (providerIdempotencyKey !== `checkout:${authorizationId}`) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        setupEpochId: rowUuid(row, "setup_epoch_id"),
        authorizationId,
        actionId,
        providerIdempotencyKey,
        state: row.state as "checkout_create_pending" | "checkout_open"
          | "async_payment_pending" | "paid" | "refund_pending" | "dispute_open",
      });
    });
  }

  reserveRecurringPurchase(input: Readonly<{
    commandId: string;
    family: RecurringFamily;
    offerCode: RecurringOfferCode;
    environment: "test" | "staging" | "production";
    receiverStripeAccountId: string;
    catalogVersionId: string;
    priceBindingId: string;
    setupEpochId: string | null;
    setupPurchaseId: string | null;
    academySourceRegistryId: string | null;
    expiresAt: Date;
  }>): Promise<Readonly<{
    replayed: boolean;
    intentId: string;
    state: RecurringState;
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const accountId = context.metadata.accountId;
      const expiresAt = exactInstant(input.expiresAt);
      const club = input.family === "operator_club"
        && (input.offerCode === "operator_club_monthly"
          || input.offerCode === "operator_club_annual")
        && input.academySourceRegistryId !== null
        && input.setupEpochId === null && input.setupPurchaseId === null;
      const businessOs = input.family === "business_os"
        && input.offerCode === "business_os"
        && input.academySourceRegistryId === null
        && input.setupEpochId !== null && input.setupPurchaseId !== null;
      if (accountId === null || context.metadata.actor.kind !== "system"
        || !uuid.test(accountId) || !uuid.test(input.commandId)
        || !uuid.test(input.catalogVersionId) || !uuid.test(input.priceBindingId)
        || !providerOwner.test(input.receiverStripeAccountId)
        || (input.setupEpochId !== null && !uuid.test(input.setupEpochId))
        || (input.setupPurchaseId !== null && !uuid.test(input.setupPurchaseId))
        || (input.academySourceRegistryId !== null
          && !uuid.test(input.academySourceRegistryId))
        || (!club && !businessOs) || expiresAt <= context.metadata.clock.now()) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const fingerprint = inputHash({
        academySourceRegistryId: input.academySourceRegistryId,
        catalogVersionId: input.catalogVersionId,
        environment: input.environment,
        expiresAt: expiresAt.toISOString(),
        family: input.family,
        offerCode: input.offerCode,
        priceBindingId: input.priceBindingId,
        receiverStripeAccountId: input.receiverStripeAccountId,
        setupEpochId: input.setupEpochId,
        setupPurchaseId: input.setupPurchaseId,
      });
      if (!hash.test(fingerprint)) throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_reserve_recurring_purchase_v1(
          ${accountId},${input.commandId},${fingerprint},${input.family},
          ${input.offerCode},${input.environment},${input.receiverStripeAccountId},
          ${input.catalogVersionId},${input.priceBindingId},${input.setupEpochId},
          ${input.setupPurchaseId},${input.academySourceRegistryId},${expiresAt},
          ${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, ["replayed", "intent_id", "state"])
        || typeof row.replayed !== "boolean"
        || typeof row.state !== "string"
        || !recurringStates.has(row.state as RecurringState)) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        intentId: rowUuid(row, "intent_id"),
        state: row.state as RecurringState,
      });
    });
  }

  recordProviderEffect(input: Readonly<{
    providerReceiptId: string;
    provider: "stripe";
    receiverStripeAccountId: string;
    leaseToken: string;
    leaseGeneration: number;
    effectKind: string;
    targetObjectId: string;
    commandId: string;
  }>): Promise<Readonly<{
    replayed: boolean;
    effectId: string;
    commandId: string;
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      if (context.metadata.actor.kind !== "system"
        || !uuid.test(input.providerReceiptId) || !uuid.test(input.targetObjectId)
        || !uuid.test(input.commandId) || input.provider !== "stripe"
        || !providerOwner.test(input.receiverStripeAccountId)
        || !uuid.test(input.leaseToken)
        || !Number.isSafeInteger(input.leaseGeneration)
        || input.leaseGeneration < 1
        || !effectKind.test(input.effectKind)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_record_provider_effect_v1(
          ${input.providerReceiptId},${input.provider},
          ${input.receiverStripeAccountId},${input.leaseToken},
          ${input.leaseGeneration},${context.metadata.accountId},
          ${input.effectKind},${input.targetObjectId},${input.commandId},
          ${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, ["replayed", "effect_id", "command_id"])
        || typeof row.replayed !== "boolean") {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        effectId: rowUuid(row, "effect_id"),
        commandId: rowUuid(row, "command_id"),
      });
    });
  }

  recordPaidPurchase(input: Readonly<{
    providerReceiptId: string;
    receiverStripeAccountId: string;
    leaseToken: string;
    leaseGeneration: number;
    authorizationId: string;
    providerPaymentIntentId: string;
    providerChargeId: string;
    grossAmount: number;
    taxAmount: number;
    purchasedAt: Date;
    commandId: string;
  }>): Promise<Readonly<{
    replayed: boolean;
    purchaseId: string;
    status: "paid" | "paid_reconciliation";
    sourceRegistryId: string | null;
    fulfillmentStatus: "fulfilled" | "reconciliation";
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const purchasedAt = exactInstant(input.purchasedAt);
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId === null
        || !uuid.test(context.metadata.accountId)
        || !uuid.test(input.providerReceiptId)
        || !providerOwner.test(input.receiverStripeAccountId)
        || !uuid.test(input.leaseToken)
        || !Number.isSafeInteger(input.leaseGeneration)
        || input.leaseGeneration < 1
        || !uuid.test(input.authorizationId)
        || !/^pi_[A-Za-z0-9._:-]+$/u.test(input.providerPaymentIntentId)
        || !/^ch_[A-Za-z0-9._:-]+$/u.test(input.providerChargeId)
        || !Number.isSafeInteger(input.grossAmount) || input.grossAmount <= 0
        || !Number.isSafeInteger(input.taxAmount) || input.taxAmount < 0
        || input.taxAmount > input.grossAmount
        || purchasedAt > context.metadata.clock.now()
        || !uuid.test(input.commandId)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_record_paid_purchase_v1(
          ${input.providerReceiptId},${input.receiverStripeAccountId},
          ${input.leaseToken},${input.leaseGeneration},${input.authorizationId},
          ${input.providerPaymentIntentId},
          ${input.providerChargeId},${input.grossAmount},${input.taxAmount},
          ${purchasedAt},${input.commandId},${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, [
        "replayed", "purchase_id", "status", "source_registry_id",
        "fulfillment_status",
      ]) || typeof row.replayed !== "boolean"
        || !["paid", "paid_reconciliation"].includes(String(row.status))
        || !["fulfilled", "reconciliation"]
          .includes(String(row.fulfillment_status))
        || (row.status === "paid" && row.fulfillment_status !== "fulfilled")
        || (row.status === "paid_reconciliation"
          && row.fulfillment_status !== "reconciliation")
        || (row.source_registry_id !== null
          && (typeof row.source_registry_id !== "string"
            || !uuid.test(row.source_registry_id)))) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        purchaseId: rowUuid(row, "purchase_id"),
        status: row.status as "paid" | "paid_reconciliation",
        sourceRegistryId: row.source_registry_id as string | null,
        fulfillmentStatus: row.fulfillment_status as
          | "fulfilled"
          | "reconciliation",
      });
    });
  }

  recordPublicSelfPacedPaid(input: Readonly<{
    providerReceiptId: string;
    receiverStripeAccountId: string;
    leaseToken: string;
    leaseGeneration: number;
    authorizationId: string;
    providerPaymentIntentId: string;
    providerChargeId: string;
    grossAmount: number;
    taxAmount: number;
    purchasedAt: Date;
    commandId: string;
    businessName: string;
    claimTokenHash: string;
    deliveryTokenCiphertext: Uint8Array;
    deliveryTokenNonce: Uint8Array;
    deliveryTokenTag: Uint8Array;
    deliveryTokenKeyId: string;
  }>): Promise<Readonly<{
    replayed: boolean;
    accountId: string;
    purchaseId: string;
    status: "paid" | "paid_reconciliation";
    sourceRegistryId: string | null;
    fulfillmentStatus: "fulfilled" | "reconciliation";
    claimId: string | null;
    deliveryId: string | null;
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const purchasedAt = exactInstant(input.purchasedAt);
      let businessName: string;
      try {
        businessName = canonicalizeAccountName(input.businessName);
      } catch {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const exactBytes = (value: Uint8Array, length?: number) =>
        value instanceof Uint8Array && (length === undefined
          ? value.byteLength >= 1 && value.byteLength <= 4096
          : value.byteLength === length);
      if (businessName !== input.businessName
        || context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null
        || !uuid.test(input.providerReceiptId)
        || !providerOwner.test(input.receiverStripeAccountId)
        || !uuid.test(input.leaseToken)
        || !Number.isSafeInteger(input.leaseGeneration)
        || input.leaseGeneration < 1 || !uuid.test(input.authorizationId)
        || !/^pi_[A-Za-z0-9._:-]+$/u.test(input.providerPaymentIntentId)
        || !/^ch_[A-Za-z0-9._:-]+$/u.test(input.providerChargeId)
        || !Number.isSafeInteger(input.grossAmount) || input.grossAmount <= 0
        || !Number.isSafeInteger(input.taxAmount) || input.taxAmount < 0
        || input.taxAmount > input.grossAmount || purchasedAt > context.metadata.clock.now()
        || !uuid.test(input.commandId) || !hash.test(input.claimTokenHash)
        || !exactBytes(input.deliveryTokenCiphertext)
        || !exactBytes(input.deliveryTokenNonce, 12)
        || !exactBytes(input.deliveryTokenTag, 16)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.deliveryTokenKeyId)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_record_public_self_paced_paid_v1(
          ${input.providerReceiptId},${input.receiverStripeAccountId},
          ${input.leaseToken},${input.leaseGeneration},${input.authorizationId},
          ${input.providerPaymentIntentId},${input.providerChargeId},
          ${input.grossAmount},${input.taxAmount},${purchasedAt},${input.commandId},
          ${businessName},${input.claimTokenHash},
          ${Buffer.from(input.deliveryTokenCiphertext)},
          ${Buffer.from(input.deliveryTokenNonce)},${Buffer.from(input.deliveryTokenTag)},
          ${input.deliveryTokenKeyId},${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, [
        "replayed", "account_id", "purchase_id", "status",
        "source_registry_id", "fulfillment_status", "claim_id", "delivery_id",
      ]) || typeof row.replayed !== "boolean"
        || !["paid", "paid_reconciliation"].includes(String(row.status))
        || !["fulfilled", "reconciliation"].includes(String(row.fulfillment_status))
        || (row.status === "paid" && (row.fulfillment_status !== "fulfilled"
          || row.claim_id === null || row.delivery_id === null))
        || (row.status === "paid_reconciliation"
          && (row.fulfillment_status !== "reconciliation"
            || row.claim_id !== null || row.delivery_id !== null))
        || (row.source_registry_id !== null
          && (typeof row.source_registry_id !== "string"
            || !uuid.test(row.source_registry_id)))
        || (row.claim_id !== null
          && (typeof row.claim_id !== "string" || !uuid.test(row.claim_id)))
        || (row.delivery_id !== null
          && (typeof row.delivery_id !== "string" || !uuid.test(row.delivery_id)))) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        accountId: rowUuid(row, "account_id"),
        purchaseId: rowUuid(row, "purchase_id"),
        status: row.status as "paid" | "paid_reconciliation",
        sourceRegistryId: row.source_registry_id as string | null,
        fulfillmentStatus: row.fulfillment_status as "fulfilled" | "reconciliation",
        claimId: row.claim_id as string | null,
        deliveryId: row.delivery_id as string | null,
      });
    });
  }

  recordPublicBusinessOsSetupPaid(input: Readonly<{
    providerReceiptId: string;
    receiverStripeAccountId: string;
    leaseToken: string;
    leaseGeneration: number;
    publicIntentId: string;
    authorizationId: string;
    providerCustomerId: string;
    providerPaymentIntentId: string;
    providerChargeId: string;
    grossAmount: number;
    taxAmount: number;
    purchasedAt: Date;
    commandId: string;
    businessName: string;
    claimTokenHash: string;
    deliveryTokenCiphertext: Uint8Array;
    deliveryTokenNonce: Uint8Array;
    deliveryTokenTag: Uint8Array;
    deliveryTokenKeyId: string;
    reconciliationReason: "STRIPE_CUSTOMER_OWNERSHIP_COLLISION"
      | "PAID_CLAIM_IDENTITY_CONFLICT" | "PAID_IDENTITY_STATE_STALE"
      | "PAID_SEMANTIC_CONFLICT" | null;
  }>): Promise<Readonly<{
    replayed: boolean;
    accountId: string;
    purchaseId: string;
    setupEpochId: string;
    status: "paid" | "paid_reconciliation";
    sourceRegistryId: string | null;
    setupKind: "recorded" | "parked_receipt" | "provider_collision";
    claimId: string | null;
    deliveryId: string | null;
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const purchasedAt = exactInstant(input.purchasedAt);
      let businessName: string;
      try { businessName = canonicalizeAccountName(input.businessName); } catch {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const bytes = (value: Uint8Array, length?: number) =>
        value instanceof Uint8Array && (length === undefined
          ? value.byteLength >= 1 && value.byteLength <= 4096
          : value.byteLength === length);
      const reasons = new Set([
        "STRIPE_CUSTOMER_OWNERSHIP_COLLISION", "PAID_CLAIM_IDENTITY_CONFLICT",
        "PAID_IDENTITY_STATE_STALE", "PAID_SEMANTIC_CONFLICT",
      ]);
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null || businessName !== input.businessName
        || !uuid.test(input.providerReceiptId)
        || !providerOwner.test(input.receiverStripeAccountId)
        || !uuid.test(input.leaseToken) || !Number.isInteger(input.leaseGeneration)
        || input.leaseGeneration < 1 || !uuid.test(input.publicIntentId)
        || !uuid.test(input.authorizationId)
        || !/^cus_[A-Za-z0-9._:-]+$/u.test(input.providerCustomerId)
        || !/^pi_[A-Za-z0-9._:-]+$/u.test(input.providerPaymentIntentId)
        || !/^ch_[A-Za-z0-9._:-]+$/u.test(input.providerChargeId)
        || !Number.isSafeInteger(input.grossAmount) || input.grossAmount <= 0
        || !Number.isSafeInteger(input.taxAmount) || input.taxAmount < 0
        || input.taxAmount > input.grossAmount || purchasedAt > context.metadata.clock.now()
        || !uuid.test(input.commandId) || !hash.test(input.claimTokenHash)
        || !bytes(input.deliveryTokenCiphertext) || !bytes(input.deliveryTokenNonce, 12)
        || !bytes(input.deliveryTokenTag, 16)
        || !providerOwner.test(input.deliveryTokenKeyId)
        || (input.reconciliationReason !== null
          && !reasons.has(input.reconciliationReason))) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_record_public_bos_setup_paid_v1(
          ${input.providerReceiptId},${input.receiverStripeAccountId},
          ${input.leaseToken},${input.leaseGeneration},${input.publicIntentId},
          ${input.authorizationId},${input.providerCustomerId},
          ${input.providerPaymentIntentId},${input.providerChargeId},
          ${input.grossAmount},${input.taxAmount},${purchasedAt},${input.commandId},
          ${businessName},${input.claimTokenHash},
          ${Buffer.from(input.deliveryTokenCiphertext)},
          ${Buffer.from(input.deliveryTokenNonce)},${Buffer.from(input.deliveryTokenTag)},
          ${input.deliveryTokenKeyId},${input.reconciliationReason},
          ${context.metadata.clock.now()}
        )
      `);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, [
        "replayed", "account_id", "purchase_id", "setup_epoch_id", "status",
        "source_registry_id", "setup_kind", "claim_id", "delivery_id",
      ]) || typeof row.replayed !== "boolean"
        || !["paid", "paid_reconciliation"].includes(String(row.status))
        || !["recorded", "parked_receipt", "provider_collision"].includes(String(row.setup_kind))
        || (row.source_registry_id !== null
          && (typeof row.source_registry_id !== "string" || !uuid.test(row.source_registry_id)))
        || (row.claim_id !== null
          && (typeof row.claim_id !== "string" || !uuid.test(row.claim_id)))
        || (row.delivery_id !== null
          && (typeof row.delivery_id !== "string" || !uuid.test(row.delivery_id)))
        || (row.status === "paid" && (row.setup_kind !== "recorded"
          || row.source_registry_id === null || row.claim_id === null
          || row.delivery_id === null))
        || (row.status === "paid_reconciliation"
          && (row.claim_id !== null || row.delivery_id !== null))) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        accountId: rowUuid(row, "account_id"), purchaseId: rowUuid(row, "purchase_id"),
        setupEpochId: rowUuid(row, "setup_epoch_id"),
        status: row.status as "paid" | "paid_reconciliation",
        sourceRegistryId: row.source_registry_id as string | null,
        setupKind: row.setup_kind as "recorded" | "parked_receipt" | "provider_collision",
        claimId: row.claim_id as string | null, deliveryId: row.delivery_id as string | null,
      });
    });
  }

  initiateClaim(input: Readonly<{
    claimTokenHash: string;
    sessionHandleHash: string;
  }>): Promise<Readonly<{
    replayed: boolean;
    pendingSessionId: string;
    accountId: string;
    offerCode: "self_paced" | "business_os";
    businessName: string;
    expiresAt: Date;
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null
        || !hash.test(input.claimTokenHash)
        || !hash.test(input.sessionHandleHash)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_initiate_claim_v1(
          ${input.claimTokenHash},${input.sessionHandleHash},
          ${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, [
        "replayed", "pending_session_id", "account_id", "offer_code",
        "business_name", "expires_at",
      ]) || typeof row.replayed !== "boolean"
        || !["self_paced", "business_os"].includes(String(row.offer_code))) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        pendingSessionId: rowUuid(row, "pending_session_id"),
        accountId: rowUuid(row, "account_id"),
        offerCode: row.offer_code as "self_paced" | "business_os",
        businessName: rowText(row, "business_name", /^.{1,480}$/u),
        expiresAt: rowInstant(row, "expires_at"),
      });
    });
  }

  redeemClaim(input: Readonly<{
    sessionHandleHash: string;
    commandId: string;
    clerkUserId: string;
    verifiedEmail: string;
    verifiedEmailFingerprint: Uint8Array;
  }>): Promise<Readonly<{
    replayed: boolean;
    accountId: string;
    identityId: string;
    membershipId: string;
    enrollmentId: string | null;
    seatActivated: boolean;
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const email = input.verifiedEmail.trim().toLowerCase();
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null
        || !hash.test(input.sessionHandleHash) || !uuid.test(input.commandId)
        || !providerOwner.test(input.clerkUserId)
        || !/^[^\s@]+@[^\s@]+$/u.test(email)
        || Buffer.byteLength(email, "utf8") < 3
        || Buffer.byteLength(email, "utf8") > 320
        || !(input.verifiedEmailFingerprint instanceof Uint8Array)
        || input.verifiedEmailFingerprint.byteLength !== 32) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const ownerInputHash = inputHash({ clerkUserId: input.clerkUserId, email });
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_redeem_claim_v1(
          ${input.sessionHandleHash},${input.commandId},${ownerInputHash},
          ${input.clerkUserId},${email},
          ${Buffer.from(input.verifiedEmailFingerprint)},
          ${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, [
        "replayed", "account_id", "identity_id", "membership_id",
        "enrollment_id", "seat_activated",
      ]) || typeof row.replayed !== "boolean"
        || typeof row.seat_activated !== "boolean"
        || (row.enrollment_id !== null
          && (typeof row.enrollment_id !== "string" || !uuid.test(row.enrollment_id)))) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        accountId: rowUuid(row, "account_id"),
        identityId: rowUuid(row, "identity_id"),
        membershipId: rowUuid(row, "membership_id"),
        enrollmentId: row.enrollment_id as string | null,
        seatActivated: row.seat_activated,
      });
    });
  }

  getOnboarding(): Promise<Readonly<{
    accountId: string;
    productFamily: "academy" | "business_os";
    version: number;
    businessName: string;
    website: string | null;
    category: string | null;
    country: string | null;
    timezone: string | null;
    teamSizeBand: string | null;
    ownerRole: string | null;
    primaryGoal: string | null;
    tools: Readonly<{ crm: readonly string[]; scheduling: readonly string[]; email: readonly string[] }>;
    priorities: readonly string[];
    scorecardAttachmentId: string | null;
    invitationStepCompleted: boolean;
    deliveryScheduleConfirmed: boolean;
    currentStep: string;
    completedAt: Date | null;
  }> | null> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const actor = context.metadata.actor;
      if (actor.kind !== "member" || context.metadata.accountId === null
        || actor.accountId !== context.metadata.accountId
        || !uuid.test(actor.actorId) || !uuid.test(actor.membershipId)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_get_onboarding_v1()
      `);
      if (result.rows.length === 0) return null;
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, [
        "account_id", "product_family", "version", "business_name", "website",
        "category", "country", "timezone", "team_size_band", "owner_role",
        "primary_goal", "tools", "priorities", "scorecard_attachment_id",
        "invitation_step_completed", "delivery_schedule_confirmed",
        "current_step", "completed_at",
      ]) || !["academy", "business_os"].includes(String(row.product_family))
        || typeof row.version !== "number" || !Number.isInteger(row.version)
        || row.version < 1 || typeof row.invitation_step_completed !== "boolean"
        || typeof row.delivery_schedule_confirmed !== "boolean"
        || typeof row.current_step !== "string"
        || !onboardingSteps.has(row.current_step)
        || !Array.isArray(row.priorities)
        || ![0, 3].includes(row.priorities.length)
        || row.priorities.some((priority) => typeof priority !== "string"
          || Buffer.byteLength(priority, "utf8") < 1
          || Buffer.byteLength(priority, "utf8") > 1000)
        || (row.scorecard_attachment_id !== null
          && (typeof row.scorecard_attachment_id !== "string"
            || !uuid.test(row.scorecard_attachment_id)))
        || (row.completed_at !== null && !(row.completed_at instanceof Date))) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        accountId: rowUuid(row, "account_id"),
        productFamily: row.product_family as "academy" | "business_os",
        version: row.version,
        businessName: rowText(row, "business_name", /^.{1,480}$/u),
        website: nullableText(row, "website"), category: nullableText(row, "category"),
        country: nullableText(row, "country"), timezone: nullableText(row, "timezone"),
        teamSizeBand: nullableText(row, "team_size_band"),
        ownerRole: nullableText(row, "owner_role"),
        primaryGoal: nullableText(row, "primary_goal"),
        tools: onboardingTools(row.tools),
        priorities: Object.freeze([...(row.priorities as string[])]),
        scorecardAttachmentId: row.scorecard_attachment_id as string | null,
        invitationStepCompleted: row.invitation_step_completed,
        deliveryScheduleConfirmed: row.delivery_schedule_confirmed,
        currentStep: row.current_step,
        completedAt: row.completed_at === null ? null : rowInstant(row, "completed_at"),
      });
    });
  }

  saveOnboarding(input: Readonly<{
    expectedVersion: number;
    businessName: string;
    website: string | null;
    category: string | null;
    country: string | null;
    timezone: string | null;
    teamSizeBand: string | null;
    ownerRole: string | null;
    primaryGoal: string | null;
    tools: Readonly<{ crm: readonly string[]; scheduling: readonly string[]; email: readonly string[] }>;
    priorities: readonly string[];
    scorecardAttachmentId: string | null;
    invitationStepCompleted: boolean;
    deliveryScheduleConfirmed: boolean;
    currentStep: string;
  }>): Promise<Readonly<{ version: number; currentStep: string; completed: false }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const actor = context.metadata.actor;
      let businessName: string;
      try { businessName = canonicalizeAccountName(input.businessName); } catch {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const safeNullable = (value: string | null, max: number) => value === null
        || (value === value.trim() && Buffer.byteLength(value, "utf8") >= 1
          && Buffer.byteLength(value, "utf8") <= max);
      let tools: ReturnType<typeof onboardingTools>;
      try { tools = onboardingTools(input.tools); } catch {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      if (actor.kind !== "member" || context.metadata.accountId === null
        || actor.accountId !== context.metadata.accountId
        || !uuid.test(actor.actorId) || !uuid.test(actor.membershipId)
        || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1
        || businessName !== input.businessName
        || !safeNullable(input.website, 2048) || !safeNullable(input.category, 255)
        || (input.country !== null && !/^[A-Z]{2}$/u.test(input.country))
        || !safeNullable(input.timezone, 255)
        || (input.teamSizeBand !== null
          && !["solo", "2-5", "6-10", "11-25", "26+"].includes(input.teamSizeBand))
        || !safeNullable(input.ownerRole, 255) || !safeNullable(input.primaryGoal, 1000)
        || ![0, 3].includes(input.priorities.length)
        || input.priorities.some((priority) => !safeNullable(priority, 1000))
        || new Set(input.priorities).size !== input.priorities.length
        || (input.scorecardAttachmentId !== null && !uuid.test(input.scorecardAttachmentId))
        || typeof input.invitationStepCompleted !== "boolean"
        || typeof input.deliveryScheduleConfirmed !== "boolean"
        || !onboardingSteps.has(input.currentStep) || input.currentStep === "complete") {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_save_onboarding_v1(
          ${input.expectedVersion},${businessName},${input.website},${input.category},
          ${input.country},${input.timezone},${input.teamSizeBand},${input.ownerRole},
          ${input.primaryGoal},${tools},${input.priorities},
          ${input.scorecardAttachmentId},${input.invitationStepCompleted},
          ${input.deliveryScheduleConfirmed},${input.currentStep},
          ${context.metadata.clock.now()}
        )
      `);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, ["version", "current_step", "completed"])
        || typeof row.version !== "number" || !Number.isInteger(row.version)
        || row.version !== input.expectedVersion + 1
        || row.current_step !== input.currentStep || row.completed !== false) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({ version: row.version, currentStep: row.current_step, completed: false as const });
    });
  }

  completeOnboarding(input: Readonly<{
    expectedVersion: number;
    idempotencyKey: string;
    requestHash: string;
  }>): Promise<Readonly<{
    replayed: boolean;
    version: number;
    destination: "academy" | "business_os";
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const actor = context.metadata.actor;
      if (actor.kind !== "member" || context.metadata.accountId === null
        || actor.accountId !== context.metadata.accountId
        || !uuid.test(actor.actorId) || !uuid.test(actor.membershipId)
        || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1
        || !/^[A-Za-z0-9._~-]{16,128}$/u.test(input.idempotencyKey)
        || !hash.test(input.requestHash)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_complete_onboarding_v1(
          ${input.expectedVersion},${input.idempotencyKey},${input.requestHash},
          ${context.metadata.clock.now()}
        )
      `);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, ["replayed", "version", "destination"])
        || typeof row.replayed !== "boolean" || typeof row.version !== "number"
        || !Number.isInteger(row.version) || row.version !== input.expectedVersion
        || !["academy", "business_os"].includes(String(row.destination))) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        version: row.version,
        destination: row.destination as "academy" | "business_os",
      });
    });
  }

  recordProviderEvent(input: Readonly<{
    providerEventId: string;
    eventType: string;
    livemode: boolean;
    apiVersion: string | null;
    providerCreatedAt: Date;
    dataObjectType: string;
    dataObjectId: string;
    eventObjectValid: boolean;
    receiverStripeAccountId: string;
    eventAccount: string | null;
    eventContext: string | null;
    rawBodySha256: string;
    expectedLivemode: boolean;
    expectedApiVersion: string;
    expectedReceiverStripeAccountId: string;
  }>): Promise<Readonly<{
    replayed: boolean;
    receiptId: string;
    status: ProviderEventRecordStatus;
  }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const providerCreatedAt = exactInstant(input.providerCreatedAt);
      const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
      const eventType = /^[a-z][a-z0-9_.]{0,127}$/u;
      const apiVersion = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
      const optionalIdentifier = (value: string | null) =>
        value === null || identifier.test(value);
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null
        || !identifier.test(input.providerEventId)
        || !eventType.test(input.eventType)
        || typeof input.livemode !== "boolean"
        || (input.apiVersion !== null && !apiVersion.test(input.apiVersion))
        || !identifier.test(input.dataObjectType)
        || !identifier.test(input.dataObjectId)
        || typeof input.eventObjectValid !== "boolean"
        || !identifier.test(input.receiverStripeAccountId)
        || !optionalIdentifier(input.eventAccount)
        || !optionalIdentifier(input.eventContext)
        || !hash.test(input.rawBodySha256)
        || typeof input.expectedLivemode !== "boolean"
        || !apiVersion.test(input.expectedApiVersion)
        || !identifier.test(input.expectedReceiverStripeAccountId)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_record_provider_event_v1(
          ${input.providerEventId},${input.eventType},${input.livemode},
          ${input.apiVersion},${providerCreatedAt},${input.dataObjectType},
          ${input.dataObjectId},${input.eventObjectValid},${input.receiverStripeAccountId},
          ${input.eventAccount},${input.eventContext},${input.rawBodySha256},
          ${input.expectedLivemode},${input.expectedApiVersion},
          ${input.expectedReceiverStripeAccountId},${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      const statuses = new Set<ProviderEventRecordStatus>([
        "received", "processing", "processed", "failed_retryable", "failed_terminal",
      ]);
      if (!exactKeys(row, ["replayed", "receipt_id", "status"])
        || typeof row.replayed !== "boolean" || typeof row.status !== "string"
        || !statuses.has(row.status as ProviderEventRecordStatus)) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        replayed: row.replayed,
        receiptId: rowUuid(row, "receipt_id"),
        status: row.status as ProviderEventRecordStatus,
      });
    });
  }

  claimProviderEvent(input: Readonly<{
    leaseDurationMs: number;
  }>): Promise<ProviderEventClaim | null> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const workerId = context.metadata.actor.actorId;
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null
        || !Number.isInteger(input.leaseDurationMs)
        || input.leaseDurationMs < 1_000 || input.leaseDurationMs > 300_000
        || !providerOwner.test(workerId)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_claim_provider_event_v1(
          ${workerId},${input.leaseDurationMs},${context.metadata.clock.now()}
        )`);
      if (result.rows.length === 0) return null;
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, [
        "receipt_id",
        "provider_event_id",
        "event_type",
        "livemode",
        "api_version",
        "provider_created_at",
        "data_object_type",
        "data_object_id",
        "receiver_stripe_account_id",
        "event_account",
        "event_context",
        "raw_body_sha256",
        "received_at",
        "lease_token",
        "lease_generation",
        "lease_expires_at",
      ]) || typeof row.livemode !== "boolean"
        || row.event_account !== null || row.event_context !== null
        || typeof row.lease_generation !== "number"
        || !Number.isInteger(row.lease_generation) || row.lease_generation <= 0) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        receiptId: rowUuid(row, "receipt_id"),
        providerEventId: rowText(row, "provider_event_id"),
        eventType: rowText(row, "event_type", /^[a-z][a-z0-9_.]{0,127}$/u),
        livemode: row.livemode,
        apiVersion: rowText(row, "api_version"),
        providerCreatedAt: rowInstant(row, "provider_created_at"),
        dataObjectType: rowText(row, "data_object_type"),
        dataObjectId: rowText(row, "data_object_id"),
        receiverStripeAccountId: rowText(row, "receiver_stripe_account_id"),
        eventAccount: null,
        eventContext: null,
        rawBodySha256: rowText(row, "raw_body_sha256", hash),
        receivedAt: rowInstant(row, "received_at"),
        leaseToken: rowUuid(row, "lease_token"),
        leaseGeneration: row.lease_generation,
        leaseExpiresAt: rowInstant(row, "lease_expires_at"),
      });
    });
  }

  finishProviderEvent(input: Readonly<{
    receiptId: string;
    leaseToken: string;
    leaseGeneration: number;
    outcome: ProviderEventOutcome;
    safeCode: string;
  }>): Promise<Readonly<{ replayed: boolean; status: ProviderEventOutcome }>> {
    const context = state.get(this)!;
    return context.guard.run(async () => {
      context.guard.assertActive();
      const workerId = context.metadata.actor.actorId;
      if (context.metadata.actor.kind !== "system"
        || context.metadata.accountId !== null
        || !uuid.test(input.receiptId) || !uuid.test(input.leaseToken)
        || !Number.isInteger(input.leaseGeneration) || input.leaseGeneration <= 0
        || !["processed", "failed_retryable", "failed_terminal"].includes(input.outcome)
        || !/^[a-z][a-z0-9_]{0,63}$/u.test(input.safeCode)
        || !providerOwner.test(workerId)) {
        throw new Error("COMMERCE_COMMAND_INPUT_INVALID");
      }
      const result = await context.transaction.execute(sql`
        select * from public.syntholo_commerce_finish_provider_event_v1(
          ${input.receiptId},${workerId},${input.leaseToken},
          ${input.leaseGeneration},${input.outcome},${input.safeCode},
          ${context.metadata.clock.now()}
        )`);
      const row = rowObject(result.rows[0]);
      if (!exactKeys(row, ["replayed", "status"])
        || typeof row.replayed !== "boolean" || row.status !== input.outcome) {
        throw new Error("COMMERCE_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({ replayed: row.replayed, status: input.outcome });
    });
  }
}
