import { createHash } from "node:crypto";
import {
  evaluateEntitlements,
  type AccountHold,
  type EntitlementEvaluationInput,
  type EntitlementGrant,
  type SeatReservation,
} from "@syntholo/domain";
import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../unit-of-work.js";
import type {
  TransactionGuard,
  TrustedTransactionMetadata,
} from "./context.js";

const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function pgCode(error: unknown): string | undefined {
  let value = error;
  while (value instanceof Error) {
    if ("code" in value && typeof value.code === "string") return value.code;
    value = value.cause;
  }
  return undefined;
}

function exactInstant(value: Date): Date {
  if (!Number.isFinite(value.getTime()) || value.getTime() % 1 !== 0) {
    throw new Error("ENTITLEMENT_TIME_INVALID");
  }
  return new Date(value);
}

function hashCommandInput(input: Readonly<Record<string, unknown>>): string {
  const normalized = Object.fromEntries(Object.entries(input)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, Buffer.isBuffer(value)
      ? value.toString("base64url")
      : value]));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function compareIds(left: Readonly<{ id: string }>, right: Readonly<{ id: string }>): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Version 1 is a fixed-field JSON serialization. Arrays are ordered by their
 * immutable row IDs, absent optional values are normalized to null, and every
 * instant is represented as an exact UTC millisecond ISO string.
 */
export function canonicalEntitlementSnapshotHashV1(
  snapshot: EntitlementEvaluationInput,
): string {
  // This rejects malformed rows, duplicate IDs, invalid bundles, and
  // cross-account data before any value can be attested by the audit log.
  evaluateEntitlements(snapshot);
  const grants = [...snapshot.grants].sort(compareIds).map((grant) => ({
    id: grant.id,
    accountId: grant.accountId,
    capability: grant.capability,
    status: grant.status,
    sourceKind: grant.sourceKind,
    sourceId: grant.sourceId,
    offerCode: grant.offerCode,
    academySourceId: grant.academySourceId ?? null,
    sourceCreatedAt: grant.sourceCreatedAt?.toISOString() ?? null,
    startsAt: grant.startsAt.toISOString(),
    endsAt: grant.endsAt?.toISOString() ?? null,
  }));
  const holds = [...snapshot.holds].sort(compareIds).map((hold) => ({
    id: hold.id,
    accountId: hold.accountId,
    kind: hold.kind,
    sourceKind: hold.sourceKind,
    sourceId: hold.sourceId,
    createdAt: hold.createdAt.toISOString(),
    releasedAt: hold.releasedAt?.toISOString() ?? null,
  }));
  const seats = [...snapshot.seats].sort(compareIds).map((seat) => ({
    id: seat.id,
    accountId: seat.accountId,
    slot: seat.slot,
    sourceId: seat.sourceId,
    state: seat.state,
    membershipId: seat.membershipId,
    invitationId: seat.invitationId,
    expiresAt: seat.expiresAt?.toISOString() ?? null,
  }));
  const canonical = JSON.stringify({
    version: 1,
    accountId: snapshot.accountId,
    now: snapshot.now.toISOString(),
    grants,
    holds,
    seats,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

type CommandRow = Readonly<{
  replayed: boolean;
  outcome: "applied" | "denied";
  result: Record<string, unknown>;
}>;

function commandRow(value: unknown): CommandRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.replayed !== "boolean"
    || (row.outcome !== "applied" && row.outcome !== "denied")
    || row.result === null || typeof row.result !== "object"
    || Array.isArray(row.result)) throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
  return row as CommandRow;
}

function commandResultText(result: Record<string, unknown>, key: string): string {
  const value = result[key];
  if (typeof value !== "string") throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
  return value;
}

function commandResultOptionalText(
  result: Record<string, unknown>,
  key: string,
): string | null {
  if (result[key] === null || result[key] === undefined) return null;
  return commandResultText(result, key);
}

function commandDenied(row: CommandRow): EntitlementDeniedOutcome {
  const code = commandResultText(row.result, "reasonCode");
  return Object.freeze({ code, replayed: row.replayed, status: "denied" });
}

function commandApplied<T>(
  row: CommandRow,
  value: T,
): EntitlementAppliedOutcome<T> {
  return Object.freeze({
    status: "applied" as const,
    replayed: row.replayed,
    value: Object.freeze(value),
  });
}

function commandResultNumber(result: Record<string, unknown>, key: string): number {
  const value = result[key];
  if (!Number.isInteger(value)) throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
  return value as number;
}

function commandResultDate(
  result: Record<string, unknown>,
  key: string,
): Date {
  const value = new Date(commandResultText(result, key));
  if (!Number.isFinite(value.getTime())) {
    throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
  }
  return value;
}

function commandResultOptionalDate(
  result: Record<string, unknown>,
  key: string,
): Date | null {
  if (result[key] === null || result[key] === undefined) return null;
  return commandResultDate(result, key);
}

function commandResultStrings(
  result: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = result[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
  }
  return Object.freeze([...value] as string[]);
}

function administrativeGrantOutcome(row: CommandRow): EntitlementCommandOutcome<{
  sourceRegistryId: string;
  grantId: string;
  capability: string;
}> {
  if (row.outcome === "denied") return commandDenied(row);
  return commandApplied(row, {
    sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
    grantId: commandResultText(row.result, "grantId"),
    capability: commandResultText(row.result, "capability"),
  });
}

export class SeatCapacityReachedError extends Error {
  readonly code = "SEAT_CAPACITY_REACHED";
  constructor() {
    super("Academy seat capacity reached");
    this.name = "SeatCapacityReachedError";
  }
}

export class EntitlementCommandDeniedError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "EntitlementCommandDeniedError";
    this.code = code;
  }
}

export type EntitlementDeniedOutcome = Readonly<{
  status: "denied";
  code: string;
  replayed: boolean;
}>;

export type EntitlementAppliedOutcome<T> = Readonly<{
  status: "applied";
  value: Readonly<T>;
  replayed: boolean;
}>;

export type EntitlementCommandOutcome<T> =
  | EntitlementAppliedOutcome<T>
  | EntitlementDeniedOutcome;

export type ProductFulfillmentValue =
  | Readonly<{
    fulfillmentStatus: "fulfilled";
    sourceRegistryId: string;
    supportEndsAt: Date | null;
    reconciliationId: null;
  }>
  | Readonly<{
    fulfillmentStatus: "reconciliation";
    reconciliationKind: "parked_receipt";
    sourceRegistryId: string;
    supportEndsAt: Date | null;
    reconciliationId: string;
    reasonCode: string;
  }>
  | Readonly<{
    fulfillmentStatus: "reconciliation";
    reconciliationKind: "provider_collision";
    sourceRegistryId: null;
    supportEndsAt: null;
    reconciliationId: string;
    reasonCode: string;
  }>;

export type ProductRefundValue =
  | Readonly<{
    refundStatus: "refunded";
    sourceRegistryId: string;
  }>
  | Readonly<{
    refundStatus: "reconciliation";
    sourceRegistryId: string;
    linkedClubSourceRegistryId: string;
    reconciliationId: string;
    reconciliationStatus: CommerceReconciliationStatus;
    holdSourceRegistryId: string;
    reasonCode: string;
  }>;

export const commerceReconciliationStatuses = Object.freeze([
  "open",
  "claimed",
  "resolved_fulfilled",
  "resolved_refund",
  "resolved_manual",
] as const);
export type CommerceReconciliationStatus =
  (typeof commerceReconciliationStatuses)[number];

export const commerceReconciliationIncidentKinds = Object.freeze([
  "parked_paid_receipt",
  "provider_source_collision",
  "linked_academy_refund",
  "linked_club_cancellation",
] as const);
export type CommerceReconciliationIncidentKind =
  (typeof commerceReconciliationIncidentKinds)[number];

export type CommerceReconciliationRecord = Readonly<{
  id: string;
  accountId: string;
  commandKind: string;
  sourceKind: string;
  sourceId: string;
  reasonCode: string;
  incidentKind: CommerceReconciliationIncidentKind;
  status: CommerceReconciliationStatus;
  reviewDueAt: Date;
  claimedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
}>;

export const publicBusinessOsReconciliationReasons = Object.freeze([
  "STRIPE_CUSTOMER_OWNERSHIP_COLLISION",
  "PAID_CLAIM_IDENTITY_CONFLICT",
  "PAID_IDENTITY_STATE_STALE",
  "PAID_SEMANTIC_CONFLICT",
] as const);
export type PublicBusinessOsReconciliationReason =
  (typeof publicBusinessOsReconciliationReasons)[number];

export type SystemDatabase = import("../client.js").Database & {
  readonly __systemDatabase: unique symbol;
};

export type EntitlementDecisionSnapshotInput = Readonly<{
  grants: readonly EntitlementGrant[];
  holds: readonly AccountHold[];
  seats: readonly SeatReservation[];
}>;

export type DecisionInput = Readonly<{
  commandId: string;
  checkKind: string;
  allowed: boolean;
  reasonCode: string;
  sourceIds: readonly string[];
  snapshot?: EntitlementDecisionSnapshotInput;
}>;

export class TransactionEntitlementRepository {
  constructor(
    transaction: DatabaseTransaction,
    metadata: TrustedTransactionMetadata,
    guard: TransactionGuard,
  ) {
    state.set(this, Object.freeze({ guard, metadata, transaction }));
    Object.freeze(this);
  }

  recordDecision(input: DecisionInput): Promise<Readonly<{
    id: string;
    allowed: boolean;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      const accountId = metadata.accountId;
      if (
        accountId === null
        || !canonicalUuid.test(input.commandId)
        || input.checkKind.trim() === ""
        || input.reasonCode.trim() === ""
      ) throw new Error("ACCESS_DECISION_INVALID");
      const sourceIds = [...new Set(input.sourceIds)].sort();
      if (sourceIds.some((id) => !canonicalUuid.test(id))) {
        throw new Error("ACCESS_DECISION_INVALID");
      }
      const now = exactInstant(metadata.clock.now());
      const snapshotHash = input.snapshot === undefined
        ? null
        : canonicalEntitlementSnapshotHashV1({
          accountId,
          now,
          grants: input.snapshot.grants,
          holds: input.snapshot.holds,
          seats: input.snapshot.seats,
        });
      const result = await transaction.execute(sql<{
        id: string;
        allowed: boolean;
      }>`select * from syntholo_record_access_decision(
        ${accountId},${input.commandId},${input.checkKind},${input.allowed},
        ${input.reasonCode},${`{${sourceIds.join(",")}}`}::uuid[],
        ${snapshotHash === null ? null : 1},${snapshotHash},${now})`);
      const row = result.rows[0] as { id: string; allowed: boolean } | undefined;
      if (!row) throw new Error("ACCESS_DECISION_RETRY_MISMATCH");
      return Object.freeze({ id: row.id, allowed: row.allowed });
    });
  }

  grantAdministrative(input: Readonly<{
    commandId: string;
    capability: "academy_course" | "support" | "circle_write" | "operator_club";
    startsAt: Date;
    endsAt: Date | null;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    grantId: string;
    capability: string;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "staff" || metadata.accountId === null) {
        throw new Error("STAFF_REQUIRED");
      }
      const startsAt = exactInstant(input.startsAt);
      const endsAt = input.endsAt === null ? null : exactInstant(input.endsAt);
      const inputHash = hashCommandInput({
        capability: input.capability,
        endsAt: endsAt?.toISOString() ?? null,
        reason: input.reason.trim(),
        startsAt: startsAt.toISOString(),
      });
      const query = await transaction.execute(sql`
        select * from syntholo_grant_administrative(
          ${metadata.accountId},${input.commandId},${inputHash},${input.capability},
          ${startsAt},${endsAt},${input.reason},${metadata.clock.now()})`);
      return administrativeGrantOutcome(commandRow(query.rows[0]));
    });
  }

  revokeAdministrative(input: Readonly<{
    commandId: string;
    grantId: string;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{ grantId: string }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "staff" || metadata.accountId === null) {
        throw new Error("STAFF_REQUIRED");
      }
      const inputHash = hashCommandInput({
        grantId: input.grantId,
        reason: input.reason.trim(),
      });
      const query = await transaction.execute(sql`
        select * from syntholo_revoke_administrative(
          ${metadata.accountId},${input.commandId},${inputHash},${input.grantId},
          ${input.reason},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        grantId: commandResultText(row.result, "grantId"),
      });
    });
  }

  restoreAdministrative(input: Readonly<{
    commandId: string;
    terminalGrantId: string;
    startsAt: Date;
    endsAt: Date | null;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    grantId: string;
    capability: string;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "staff" || metadata.accountId === null) {
        throw new Error("STAFF_REQUIRED");
      }
      const startsAt = exactInstant(input.startsAt);
      const endsAt = input.endsAt === null ? null : exactInstant(input.endsAt);
      const inputHash = hashCommandInput({
        endsAt: endsAt?.toISOString() ?? null,
        reason: input.reason.trim(),
        startsAt: startsAt.toISOString(),
        terminalGrantId: input.terminalGrantId,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_restore_administrative(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.terminalGrantId},${startsAt},${endsAt},${input.reason},
          ${metadata.clock.now()})`);
      return administrativeGrantOutcome(commandRow(query.rows[0]));
    });
  }

  suspendAccount(input: Readonly<{
    commandId: string;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{
    accountId: string;
    status: "suspended";
  }>> {
    return this.runStaffAccountCommand("suspend_account", input);
  }

  reactivateAccount(input: Readonly<{
    commandId: string;
    ownerMembershipId: string;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{
    accountId: string;
    ownerMembershipId: string;
    status: "active";
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "staff" || metadata.accountId === null) {
        throw new Error("STAFF_REQUIRED");
      }
      const inputHash = hashCommandInput({
        ownerMembershipId: input.ownerMembershipId,
        reason: input.reason.trim(),
      });
      const query = await transaction.execute(sql`
        select * from syntholo_reactivate_account(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.ownerMembershipId},${input.reason},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        accountId: commandResultText(row.result, "accountId"),
        ownerMembershipId: commandResultText(row.result, "ownerMembershipId"),
        status: "active" as const,
      });
    });
  }

  revokeMember(input: Readonly<{
    commandId: string;
    membershipId: string;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{
    membershipId: string;
    reservationId: string;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "staff" || metadata.accountId === null) {
        throw new Error("STAFF_REQUIRED");
      }
      const inputHash = hashCommandInput({
        membershipId: input.membershipId,
        reason: input.reason.trim(),
      });
      const query = await transaction.execute(sql`
        select * from syntholo_revoke_member(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.membershipId},${input.reason},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        membershipId: commandResultText(row.result, "membershipId"),
        reservationId: commandResultText(row.result, "reservationId"),
      });
    });
  }

  recordBusinessOsSetupPurchase(input: Readonly<{
    commandId: string;
    sourceId: string;
    purchasedAt: Date;
  }>): Promise<EntitlementCommandOutcome<
    | Readonly<{
      setupKind: "recorded" | "parked_receipt";
      sourceRegistryId: string;
      reconciliationId: string | null;
      receiptStatus: "paid" | "paid_reconciliation";
    }>
    | Readonly<{
      setupKind: "provider_collision";
      sourceRegistryId: null;
      reconciliationId: string;
      receiptStatus: "paid_reconciliation";
    }>
  >> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const purchasedAt = exactInstant(input.purchasedAt);
      const inputHash = hashCommandInput({
        purchasedAt: purchasedAt.toISOString(),
        sourceId: input.sourceId,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_record_business_os_setup_purchase(
          ${metadata.accountId},${input.commandId},${inputHash},${input.sourceId},
          ${purchasedAt},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      const setupKind = commandResultText(row.result, "setupKind");
      const receiptStatus = commandResultText(row.result, "receiptStatus");
      if (setupKind === "provider_collision"
        && receiptStatus === "paid_reconciliation"
        && commandResultOptionalText(row.result, "sourceRegistryId") === null) {
        return commandApplied(row, {
          setupKind,
          sourceRegistryId: null,
          reconciliationId: commandResultText(row.result, "reconciliationId"),
          receiptStatus,
        });
      }
      if ((setupKind === "recorded" || setupKind === "parked_receipt")
        && (receiptStatus === "paid" || receiptStatus === "paid_reconciliation")) {
        return commandApplied(row, {
          setupKind,
          sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
          reconciliationId: commandResultOptionalText(row.result, "reconciliationId"),
          receiptStatus,
        });
      }
      throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
    });
  }

  recordPublicBusinessOsSetupReconciliation(input: Readonly<{
    commandId: string;
    sourceId: string;
    purchasedAt: Date;
    reconciliationReason: PublicBusinessOsReconciliationReason;
  }>): Promise<EntitlementCommandOutcome<Readonly<{
    setupKind: "provider_collision" | "parked_receipt";
    sourceRegistryId: string;
    reconciliationId: string;
    receiptStatus: "paid_reconciliation";
  }>>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      if (!publicBusinessOsReconciliationReasons.includes(
        input.reconciliationReason,
      )) throw new Error("PUBLIC_BUSINESS_OS_RECONCILIATION_INVALID");
      const purchasedAt = exactInstant(input.purchasedAt);
      const inputHash = hashCommandInput({
        purchasedAt: purchasedAt.toISOString(),
        reconciliationReason: input.reconciliationReason,
        sourceId: input.sourceId,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_record_public_business_os_setup_reconciliation(
          ${metadata.accountId},${input.commandId},${inputHash},${input.sourceId},
          ${purchasedAt},${input.reconciliationReason},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      const setupKind = commandResultText(row.result, "setupKind");
      if ((setupKind !== "provider_collision" && setupKind !== "parked_receipt")
        || commandResultText(row.result, "receiptStatus") !== "paid_reconciliation") {
        throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
      }
      return commandApplied(row, {
        setupKind,
        sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
        reconciliationId: commandResultText(row.result, "reconciliationId"),
        receiptStatus: "paid_reconciliation",
      });
    });
  }

  reconcileBusinessOsSetup(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    receiptStatus: "paid";
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "staff" || metadata.accountId === null) {
        throw new Error("STAFF_REQUIRED");
      }
      const inputHash = hashCommandInput({
        reason: input.reason.trim(),
        sourceRegistryId: input.sourceRegistryId,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_reconcile_business_os_setup(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${input.reason},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
        receiptStatus: "paid" as const,
      });
    });
  }

  listCommerceReconciliations(input: Readonly<{
    status?: "open" | "claimed";
    limit?: number;
  }> = {}): Promise<readonly CommerceReconciliationRecord[]> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "staff" || metadata.accountId === null) {
        throw new Error("STAFF_REQUIRED");
      }
      if (metadata.actor.role !== "admin"
        || !metadata.actor.permissions.includes("entitlements:manage")) {
        throw new Error("STAFF_ENTITLEMENT_AUTHORITY_REQUIRED");
      }
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("COMMERCE_RECONCILIATION_QUERY_INVALID");
      }
      const query = await transaction.execute(sql`
        select id,account_id as "accountId",command_kind as "commandKind",
          source_kind as "sourceKind",source_id as "sourceId",
          reason_code as "reasonCode",incident_kind as "incidentKind",status,
          review_due_at as "reviewDueAt",
          claimed_at as "claimedAt",resolved_at as "resolvedAt",
          created_at as "createdAt"
        from syntholo_list_commerce_reconciliations(
          ${metadata.accountId},${input.status ?? null},${limit},${metadata.clock.now()})`);
      return Object.freeze(query.rows.map((value) => {
        if (value === null || typeof value !== "object") {
          throw new Error("COMMERCE_RECONCILIATION_RESULT_INVALID");
        }
        const row = value as Record<string, unknown>;
        const status = row.status;
        if (typeof row.id !== "string" || typeof row.accountId !== "string"
          || typeof row.commandKind !== "string" || typeof row.sourceKind !== "string"
          || typeof row.sourceId !== "string" || typeof row.reasonCode !== "string"
          || !commerceReconciliationIncidentKinds.includes(
            row.incidentKind as CommerceReconciliationIncidentKind,
          )
          || !commerceReconciliationStatuses.includes(
            status as CommerceReconciliationStatus,
          )) {
          throw new Error("COMMERCE_RECONCILIATION_RESULT_INVALID");
        }
        const toDate = (field: string): Date | null => {
          if (row[field] === null) return null;
          const date = row[field] instanceof Date
            ? new Date(row[field].getTime())
            : new Date(String(row[field]));
          if (!Number.isFinite(date.getTime())) {
            throw new Error("COMMERCE_RECONCILIATION_RESULT_INVALID");
          }
          return date;
        };
        const reviewDueAt = toDate("reviewDueAt");
        const createdAt = toDate("createdAt");
        if (reviewDueAt === null || createdAt === null) {
          throw new Error("COMMERCE_RECONCILIATION_RESULT_INVALID");
        }
        return Object.freeze({
          id: row.id,
          accountId: row.accountId,
          commandKind: row.commandKind,
          sourceKind: row.sourceKind,
          sourceId: row.sourceId,
          reasonCode: row.reasonCode,
          incidentKind: row.incidentKind as CommerceReconciliationIncidentKind,
          status: status as CommerceReconciliationStatus,
          reviewDueAt,
          claimedAt: toDate("claimedAt"),
          resolvedAt: toDate("resolvedAt"),
          createdAt,
        });
      }));
    });
  }

  claimCommerceReconciliation(input: Readonly<{
    commandId: string;
    reconciliationId: string;
  }>): Promise<EntitlementCommandOutcome<{
    reconciliationId: string;
    status: "claimed";
    reviewDueAt: Date;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "staff" || metadata.accountId === null) {
        throw new Error("STAFF_REQUIRED");
      }
      const inputHash = hashCommandInput({ reconciliationId: input.reconciliationId });
      const query = await transaction.execute(sql`
        select * from syntholo_claim_commerce_reconciliation(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.reconciliationId},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        reconciliationId: commandResultText(row.result, "reconciliationId"),
        status: "claimed" as const,
        reviewDueAt: commandResultDate(row.result, "reviewDueAt"),
      });
    });
  }

  resolveCommerceReconciliation(input: Readonly<{
    commandId: string;
    reconciliationId: string;
    resolution:
      | "refund"
      | "manual"
      | "club_cancelled"
      | "club_refunded"
      | "abort_refund";
    paidThroughAt?: Date;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{
    reconciliationId: string;
    status: "resolved_refund" | "resolved_manual";
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "staff" || metadata.accountId === null) {
        throw new Error("STAFF_REQUIRED");
      }
      const inputHash = hashCommandInput({
        paidThroughAt: input.paidThroughAt === undefined
          ? null
          : exactInstant(input.paidThroughAt).toISOString(),
        reason: input.reason.trim(),
        reconciliationId: input.reconciliationId,
        resolution: input.resolution,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_resolve_commerce_reconciliation(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.reconciliationId},${input.resolution},
          ${input.paidThroughAt === undefined
            ? null
            : exactInstant(input.paidThroughAt)},${input.reason},
          ${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      const status = commandResultText(row.result, "status");
      if (status !== "resolved_refund" && status !== "resolved_manual") {
        throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
      }
      return commandApplied(row, {
        reconciliationId: commandResultText(row.result, "reconciliationId"),
        status,
      });
    });
  }

  establishOwner(input: Readonly<{
    commandId: string;
    clerkUserId: string;
    email: string;
  }>): Promise<EntitlementCommandOutcome<{
    identityId: string;
    membershipId: string;
    seatActivated: boolean;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const inputHash = hashCommandInput({
        clerkUserId: input.clerkUserId,
        email: input.email.trim().toLowerCase(),
      });
      const query = await transaction.execute(sql<{
        replayed: boolean;
        outcome: "applied" | "denied";
        result: Record<string, unknown>;
      }>`select * from syntholo_establish_owner(
        ${metadata.accountId},${input.commandId},${inputHash},
        ${input.clerkUserId},${input.email},
        ${exactInstant(metadata.clock.now())})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      const seatActivated = row.result.seatActivated;
      if (typeof seatActivated !== "boolean") {
        throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        status: "applied" as const,
        replayed: row.replayed,
        value: Object.freeze({
          identityId: commandResultText(row.result, "identityId"),
          membershipId: commandResultText(row.result, "membershipId"),
          seatActivated,
        }),
      });
    });
  }

  reservePendingSeat(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
    email: string;
    tokenHash: Buffer;
  }>): Promise<EntitlementCommandOutcome<{
    reservationId: string;
    invitationId: string;
    slot: number;
    expiresAt: Date;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "member" || metadata.accountId === null) {
        throw new Error("MEMBER_REQUIRED");
      }
      try {
        const inputHash = hashCommandInput({
          sourceRegistryId: input.sourceRegistryId,
          email: input.email.trim().toLowerCase(),
          tokenHash: input.tokenHash,
        });
        const query = await transaction.execute(sql<{
          replayed: boolean;
          outcome: "applied" | "denied";
          result: Record<string, unknown>;
        }>`select * from syntholo_reserve_pending_seat(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${input.email},
          ${input.tokenHash},${metadata.clock.now()})`);
        const row = commandRow(query.rows[0]);
        if (row.outcome === "denied") return commandDenied(row);
        if (typeof row.result.slot !== "number") {
          throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
        }
        return Object.freeze({
          status: "applied" as const,
          replayed: row.replayed,
          value: Object.freeze({
            reservationId: commandResultText(row.result, "reservationId"),
            invitationId: commandResultText(row.result, "invitationId"),
            slot: row.result.slot,
            expiresAt: new Date(commandResultText(row.result, "expiresAt")),
          }),
        });
      } catch (error) {
        if (error instanceof Error
          && error.message.includes("SYNTHOLO_SEAT_CAPACITY_REACHED")) {
          throw new SeatCapacityReachedError();
        }
        throw error;
      }
    });
  }

  resendInvitation(input: Readonly<{
    commandId: string;
    invitationId: string;
    tokenHash: Buffer;
  }>): Promise<EntitlementCommandOutcome<{
    invitationId: string;
    expiresAt: Date;
    generation: number;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "member" || metadata.accountId === null) {
        throw new Error("MEMBER_REQUIRED");
      }
      const inputHash = hashCommandInput({
        invitationId: input.invitationId,
        tokenHash: input.tokenHash,
      });
      const query = await transaction.execute(sql<{
        replayed: boolean;
        outcome: "applied" | "denied";
        result: Record<string, unknown>;
      }>`select * from syntholo_resend_invitation(
        ${metadata.accountId},${input.commandId},${inputHash},
        ${input.invitationId},${input.tokenHash},
        ${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      if (typeof row.result.generation !== "number") {
        throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
      }
      return Object.freeze({
        status: "applied" as const,
        replayed: row.replayed,
        value: Object.freeze({
          invitationId: commandResultText(row.result, "invitationId"),
          expiresAt: new Date(commandResultText(row.result, "expiresAt")),
          generation: row.result.generation,
        }),
      });
    });
  }

  fulfillProduct(input: Readonly<{
    commandId: string;
    sourceKind: "purchase" | "subscription";
    sourceId: string;
    offerCode:
      | "guided_pilot"
      | "self_paced"
      | "operator_club_monthly"
      | "operator_club_annual"
      | "business_os";
    academySourceRegistryId?: string;
    startsAt: Date;
    endsAt?: Date;
  }>): Promise<EntitlementCommandOutcome<ProductFulfillmentValue>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const startsAt = exactInstant(input.startsAt);
      const endsAt = input.endsAt === undefined ? null : exactInstant(input.endsAt);
      const inputHash = hashCommandInput({
        academySourceRegistryId: input.academySourceRegistryId ?? null,
        endsAt: endsAt?.toISOString() ?? null,
        offerCode: input.offerCode,
        sourceId: input.sourceId,
        sourceKind: input.sourceKind,
        startsAt: startsAt.toISOString(),
      });
      const query = await transaction.execute(sql`
        select * from syntholo_fulfill_product(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceKind},${input.sourceId},${input.offerCode},
          ${input.academySourceRegistryId ?? null},${startsAt},${endsAt},
          ${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      const fulfillmentStatus = commandResultText(
        row.result,
        "fulfillmentStatus",
      );
      if (fulfillmentStatus === "fulfilled") {
        return commandApplied(row, {
          fulfillmentStatus,
          sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
          supportEndsAt: commandResultOptionalDate(row.result, "supportEndsAt"),
          reconciliationId: null,
        });
      }
      if (fulfillmentStatus === "reconciliation") {
        const reconciliationKind = commandResultText(
          row.result,
          "reconciliationKind",
        );
        const common = {
          fulfillmentStatus,
          reconciliationId: commandResultText(row.result, "reconciliationId"),
          reasonCode: commandResultText(row.result, "reasonCode"),
        } as const;
        if (reconciliationKind === "parked_receipt") {
          return commandApplied(row, {
            ...common,
            reconciliationKind,
            sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
            supportEndsAt: commandResultOptionalDate(row.result, "supportEndsAt"),
          });
        }
        if (reconciliationKind === "provider_collision"
          && commandResultOptionalText(row.result, "sourceRegistryId") === null
          && commandResultOptionalDate(row.result, "supportEndsAt") === null) {
          return commandApplied(row, {
            ...common,
            reconciliationKind,
            sourceRegistryId: null,
            supportEndsAt: null,
          });
        }
        throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
      }
      throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
    });
  }

  reconcileProductFulfillment(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    fulfillmentStatus: "fulfilled";
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "staff" || metadata.accountId === null) {
        throw new Error("STAFF_REQUIRED");
      }
      const inputHash = hashCommandInput({
        reason: input.reason.trim(),
        sourceRegistryId: input.sourceRegistryId,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_reconcile_product_fulfillment(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${input.reason},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
        fulfillmentStatus: "fulfilled" as const,
      });
    });
  }

  redeemInvitation(input: Readonly<{
    commandId: string;
    tokenHash: Buffer;
    clerkUserId: string;
    email: string;
  }>): Promise<EntitlementCommandOutcome<{
    identityId: string;
    membershipId: string;
    reservationId: string;
    slot: number;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const inputHash = hashCommandInput({
        clerkUserId: input.clerkUserId,
        email: input.email.trim().toLowerCase(),
        tokenHash: input.tokenHash,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_redeem_invitation(
          ${metadata.accountId},${input.commandId},${inputHash},${input.tokenHash},
          ${input.clerkUserId},${input.email},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        identityId: commandResultText(row.result, "identityId"),
        membershipId: commandResultText(row.result, "membershipId"),
        reservationId: commandResultText(row.result, "reservationId"),
        slot: commandResultNumber(row.result, "slot"),
      });
    });
  }

  expireInvitation(input: Readonly<{
    commandId: string;
    invitationId: string;
  }>): Promise<EntitlementCommandOutcome<{
    invitationId: string;
    reservationId: string;
    slot: number;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const inputHash = hashCommandInput({ invitationId: input.invitationId });
      const query = await transaction.execute(sql`
        select * from syntholo_expire_invitation(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.invitationId},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        invitationId: commandResultText(row.result, "invitationId"),
        reservationId: commandResultText(row.result, "reservationId"),
        slot: commandResultNumber(row.result, "slot"),
      });
    });
  }

  revokeSeat(input: Readonly<{
    commandId: string;
    reservationId: string;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{
    reservationId: string;
    slot: number;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "member" || metadata.accountId === null) {
        throw new Error("MEMBER_REQUIRED");
      }
      const inputHash = hashCommandInput({
        reason: input.reason.trim(), reservationId: input.reservationId,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_revoke_seat(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.reservationId},${input.reason},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        reservationId: commandResultText(row.result, "reservationId"),
        slot: commandResultNumber(row.result, "slot"),
      });
    });
  }

  replaceSeat(input: Readonly<{
    commandId: string;
    targetMembershipId: string;
    email: string;
    tokenHash: Buffer;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{
    reservationId: string;
    invitationId: string;
    slot: number;
    expiresAt: Date;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "member" || metadata.accountId === null) {
        throw new Error("MEMBER_REQUIRED");
      }
      const inputHash = hashCommandInput({
        email: input.email.trim().toLowerCase(), reason: input.reason.trim(),
        targetMembershipId: input.targetMembershipId, tokenHash: input.tokenHash,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_replace_seat(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.targetMembershipId},${input.email},${input.tokenHash},
          ${input.reason},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        reservationId: commandResultText(row.result, "reservationId"),
        invitationId: commandResultText(row.result, "invitationId"),
        slot: commandResultNumber(row.result, "slot"),
        expiresAt: commandResultDate(row.result, "expiresAt"),
      });
    });
  }

  transferOwnership(input: Readonly<{
    commandId: string;
    targetMembershipId: string;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<{
    previousOwnerMembershipId: string;
    ownerMembershipId: string;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "member" || metadata.accountId === null) {
        throw new Error("MEMBER_REQUIRED");
      }
      const inputHash = hashCommandInput({
        reason: input.reason.trim(), targetMembershipId: input.targetMembershipId,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_transfer_ownership(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.targetMembershipId},${input.reason},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        previousOwnerMembershipId: commandResultText(
          row.result,
          "previousOwnerMembershipId",
        ),
        ownerMembershipId: commandResultText(row.result, "ownerMembershipId"),
      });
    });
  }

  refundProduct(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
    reason: string;
  }>): Promise<EntitlementCommandOutcome<ProductRefundValue>> {
    return this.runSystemSourceCommand(
      "refund_product",
      "syntholo_refund_product",
      input,
    );
  }

  openDispute(input: Readonly<{
    commandId: string;
    disputeId: string;
    targetSourceRegistryId: string;
  }>): Promise<EntitlementCommandOutcome<
    | Readonly<{ disputeStatus: "held"; holdSourceRegistryId: string }>
    | Readonly<{
      disputeStatus: "reconciliation";
      reconciliationId: string;
      reconciliationStatus: CommerceReconciliationStatus;
      holdSourceRegistryId: null;
    }>
  >> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const inputHash = hashCommandInput({
        disputeId: input.disputeId,
        targetSourceRegistryId: input.targetSourceRegistryId,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_open_dispute(
          ${metadata.accountId},${input.commandId},${inputHash},${input.disputeId},
          ${input.targetSourceRegistryId},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      const reconciliationId = commandResultOptionalText(
        row.result,
        "reconciliationId",
      );
      if (reconciliationId !== null) {
        const reconciliationStatus = commandResultText(
          row.result,
          "reconciliationStatus",
        );
        if (!["open", "claimed", "resolved_fulfilled", "resolved_refund",
          "resolved_manual"].includes(reconciliationStatus)) {
          throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
        }
        return commandApplied(row, {
          disputeStatus: "reconciliation" as const,
          reconciliationId,
          reconciliationStatus: reconciliationStatus as CommerceReconciliationStatus,
          holdSourceRegistryId: null,
        });
      }
      return commandApplied(row, {
        disputeStatus: "held" as const,
        holdSourceRegistryId: commandResultText(row.result, "holdSourceRegistryId"),
      });
    });
  }

  resolveDispute(input: Readonly<{
    commandId: string;
    holdSourceRegistryId: string;
    resolution: "won" | "lost";
  }>): Promise<EntitlementCommandOutcome<{
    holdSourceRegistryId: string;
    resolution: string;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const inputHash = hashCommandInput({
        holdSourceRegistryId: input.holdSourceRegistryId,
        resolution: input.resolution,
      });
      const query = await transaction.execute(sql`
        select * from syntholo_resolve_dispute(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.holdSourceRegistryId},${input.resolution},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        holdSourceRegistryId: commandResultText(row.result, "holdSourceRegistryId"),
        resolution: commandResultText(row.result, "resolution"),
      });
    });
  }

  markClubPaymentFailed(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    graceEndsAt: Date;
  }>> {
    return this.runClubIntervalCommand(
      "club_payment_failed",
      "syntholo_club_payment_failed",
      input,
      true,
    );
  }

  recoverClubPayment(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>> {
    return this.runClubIntervalCommand(
      "club_payment_recovered",
      "syntholo_club_payment_recovered",
      input,
      false,
    );
  }

  cancelClub(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    paidThroughAt: Date;
    reconciliationId?: string;
    reconciliationStatus?: "open";
  }>> {
    return this.runClubIntervalCommand(
      "club_cancelled",
      "syntholo_club_cancelled",
      input,
      false,
    );
  }

  expireClub(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    expiredCapabilities: readonly string[];
  }>> {
    return this.runSystemExpiryCommand(
      "expire_club",
      "syntholo_expire_club",
      input,
    );
  }

  expireIncludedSupport(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    expiredCapabilities: readonly string[];
  }>> {
    return this.runSystemExpiryCommand(
      "expire_support",
      "syntholo_expire_included_support",
      input,
    );
  }

  renewBusinessOs(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>> {
    return this.runBusinessOsIntervalCommand(
      "syntholo_business_os_renewed",
      input,
    );
  }

  markBusinessOsPaymentFailed(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    graceEndsAt: Date;
  }>> {
    return this.runBusinessOsPaymentCommand(
      "syntholo_business_os_payment_failed",
      input,
      true,
    );
  }

  recoverBusinessOsPayment(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>> {
    return this.runBusinessOsPaymentCommand(
      "syntholo_business_os_payment_recovered",
      input,
      false,
    );
  }

  cancelBusinessOs(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    paidThroughAt: Date;
    reconciliationId?: string;
    reconciliationStatus?: "open";
  }>> {
    return this.runBusinessOsIntervalCommand(
      "syntholo_business_os_cancelled",
      input,
    );
  }

  expireBusinessOs(input: Readonly<{
    commandId: string;
    sourceRegistryId: string;
  }>): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    expiredCapabilities: readonly string[];
  }>> {
    return this.runSystemExpiryCommand(
      "expire_business_os",
      "syntholo_expire_business_os",
      input,
    );
  }

  private runSystemSourceCommand(
    kind: "refund_product",
    functionName: "syntholo_refund_product",
    input: Readonly<{ commandId: string; sourceRegistryId: string; reason: string }>,
  ): Promise<EntitlementCommandOutcome<ProductRefundValue>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const inputHash = hashCommandInput({
        reason: input.reason.trim(), sourceRegistryId: input.sourceRegistryId,
      });
      const query = functionName === "syntholo_refund_product"
        ? await transaction.execute(sql`select * from syntholo_refund_product(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${input.reason},${metadata.clock.now()})`)
        : undefined;
      if (query === undefined) throw new Error(`ENTITLEMENT_COMMAND_UNSUPPORTED:${kind}`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      const refundStatus = commandResultText(row.result, "refundStatus");
      if (refundStatus === "reconciliation") {
        const reconciliationStatus = commandResultText(
          row.result,
          "reconciliationStatus",
        );
        if (!["open", "claimed", "resolved_fulfilled", "resolved_refund",
          "resolved_manual"].includes(reconciliationStatus)) {
          throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
        }
        return commandApplied(row, {
          refundStatus,
          sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
          linkedClubSourceRegistryId: commandResultText(
            row.result,
            "linkedClubSourceRegistryId",
          ),
          reconciliationId: commandResultText(row.result, "reconciliationId"),
          reconciliationStatus: reconciliationStatus as CommerceReconciliationStatus,
          holdSourceRegistryId: commandResultText(
            row.result,
            "holdSourceRegistryId",
          ),
          reasonCode: commandResultText(row.result, "reasonCode"),
        });
      }
      if (refundStatus !== "refunded") {
        throw new Error("ENTITLEMENT_COMMAND_RESULT_INVALID");
      }
      return commandApplied(row, {
        refundStatus,
        sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
      });
    });
  }

  private runClubIntervalCommand(
    kind: "club_payment_failed",
    functionName: "syntholo_club_payment_failed",
    input: Readonly<{
      commandId: string;
      sourceRegistryId: string;
      paidThroughAt: Date;
    }>,
    failure: true,
  ): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    graceEndsAt: Date;
  }>>;

  private runClubIntervalCommand(
    kind: "club_payment_recovered" | "club_cancelled",
    functionName: "syntholo_club_payment_recovered" | "syntholo_club_cancelled",
    input: Readonly<{
      commandId: string;
      sourceRegistryId: string;
      paidThroughAt: Date;
    }>,
    failure: false,
  ): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>>;

  private runClubIntervalCommand(
    kind: "club_payment_failed" | "club_payment_recovered" | "club_cancelled",
    functionName:
      | "syntholo_club_payment_failed"
      | "syntholo_club_payment_recovered"
      | "syntholo_club_cancelled",
    input: Readonly<{
      commandId: string;
      sourceRegistryId: string;
      paidThroughAt: Date;
    }>,
    failure: boolean,
  ): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    graceEndsAt: Date;
  }> | EntitlementCommandOutcome<{
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const paidThroughAt = exactInstant(input.paidThroughAt);
      const inputHash = hashCommandInput({
        paidThroughAt: paidThroughAt.toISOString(),
        sourceRegistryId: input.sourceRegistryId,
      });
      let query;
      if (functionName === "syntholo_club_payment_failed") {
        query = await transaction.execute(sql`select * from syntholo_club_payment_failed(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${paidThroughAt},${metadata.clock.now()})`);
      } else if (functionName === "syntholo_club_payment_recovered") {
        query = await transaction.execute(sql`select * from syntholo_club_payment_recovered(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${paidThroughAt},${metadata.clock.now()})`);
      } else {
        query = await transaction.execute(sql`select * from syntholo_club_cancelled(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${paidThroughAt},${metadata.clock.now()})`);
      }
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      if (failure) {
        return commandApplied(row, {
          sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
          graceEndsAt: commandResultDate(row.result, "graceEndsAt"),
        });
      }
      return commandApplied(row, {
        sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
        paidThroughAt: commandResultDate(row.result, "paidThroughAt"),
        ...(row.result.reconciliationStatus === "open" ? {
          reconciliationId: commandResultText(row.result, "reconciliationId"),
          reconciliationStatus: "open" as const,
        } : {}),
      });
    });
  }

  private runBusinessOsIntervalCommand(
    functionName: "syntholo_business_os_renewed" | "syntholo_business_os_cancelled",
    input: Readonly<{
      commandId: string;
      sourceRegistryId: string;
      paidThroughAt: Date;
    }>,
  ): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const paidThroughAt = exactInstant(input.paidThroughAt);
      const inputHash = hashCommandInput({
        paidThroughAt: paidThroughAt.toISOString(),
        sourceRegistryId: input.sourceRegistryId,
      });
      const query = functionName === "syntholo_business_os_renewed"
        ? await transaction.execute(sql`select * from syntholo_business_os_renewed(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${paidThroughAt},${metadata.clock.now()})`)
        : await transaction.execute(sql`select * from syntholo_business_os_cancelled(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${paidThroughAt},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
        paidThroughAt: commandResultDate(row.result, "paidThroughAt"),
        ...(row.result.reconciliationStatus === "open" ? {
          reconciliationId: commandResultText(row.result, "reconciliationId"),
          reconciliationStatus: "open" as const,
        } : {}),
      });
    });
  }

  private runBusinessOsPaymentCommand(
    functionName: "syntholo_business_os_payment_failed",
    input: Readonly<{
      commandId: string;
      sourceRegistryId: string;
      paidThroughAt: Date;
    }>,
    failure: true,
  ): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    graceEndsAt: Date;
  }>>;

  private runBusinessOsPaymentCommand(
    functionName: "syntholo_business_os_payment_recovered",
    input: Readonly<{
      commandId: string;
      sourceRegistryId: string;
      paidThroughAt: Date;
    }>,
    failure: false,
  ): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>>;

  private runBusinessOsPaymentCommand(
    functionName:
      | "syntholo_business_os_payment_failed"
      | "syntholo_business_os_payment_recovered",
    input: Readonly<{
      commandId: string;
      sourceRegistryId: string;
      paidThroughAt: Date;
    }>,
    failure: boolean,
  ): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    graceEndsAt: Date;
  }> | EntitlementCommandOutcome<{
    sourceRegistryId: string;
    paidThroughAt: Date;
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const paidThroughAt = exactInstant(input.paidThroughAt);
      const inputHash = hashCommandInput({
        paidThroughAt: paidThroughAt.toISOString(),
        sourceRegistryId: input.sourceRegistryId,
      });
      const query = functionName === "syntholo_business_os_payment_failed"
        ? await transaction.execute(sql`
          select * from syntholo_business_os_payment_failed(
            ${metadata.accountId},${input.commandId},${inputHash},
            ${input.sourceRegistryId},${paidThroughAt},${metadata.clock.now()})`)
        : await transaction.execute(sql`
          select * from syntholo_business_os_payment_recovered(
            ${metadata.accountId},${input.commandId},${inputHash},
            ${input.sourceRegistryId},${paidThroughAt},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      if (failure) {
        return commandApplied(row, {
          sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
          graceEndsAt: commandResultDate(row.result, "graceEndsAt"),
        });
      }
      return commandApplied(row, {
        sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
        paidThroughAt: commandResultDate(row.result, "paidThroughAt"),
      });
    });
  }

  private runStaffAccountCommand(
    kind: "suspend_account",
    input: Readonly<{ commandId: string; reason: string }>,
  ): Promise<EntitlementCommandOutcome<{
    accountId: string;
    status: "suspended";
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "staff" || metadata.accountId === null) {
        throw new Error("STAFF_REQUIRED");
      }
      const inputHash = hashCommandInput({ reason: input.reason.trim() });
      const query = await transaction.execute(sql`
        select * from syntholo_suspend_account(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.reason},${metadata.clock.now()})`);
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        accountId: commandResultText(row.result, "accountId"),
        status: "suspended" as const,
      });
    });
  }

  private runSystemExpiryCommand(
    kind: "expire_club" | "expire_support" | "expire_business_os",
    functionName:
      | "syntholo_expire_club"
      | "syntholo_expire_included_support"
      | "syntholo_expire_business_os",
    input: Readonly<{ commandId: string; sourceRegistryId: string }>,
  ): Promise<EntitlementCommandOutcome<{
    sourceRegistryId: string;
    expiredCapabilities: readonly string[];
  }>> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.actor.kind !== "system" || metadata.accountId === null) {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      const inputHash = hashCommandInput({ sourceRegistryId: input.sourceRegistryId });
      let query;
      if (functionName === "syntholo_expire_club") {
        query = await transaction.execute(sql`select * from syntholo_expire_club(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${metadata.clock.now()})`);
      } else if (functionName === "syntholo_expire_business_os") {
        query = await transaction.execute(sql`select * from syntholo_expire_business_os(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${metadata.clock.now()})`);
      } else {
        query = await transaction.execute(sql`select * from syntholo_expire_included_support(
          ${metadata.accountId},${input.commandId},${inputHash},
          ${input.sourceRegistryId},${metadata.clock.now()})`);
      }
      const row = commandRow(query.rows[0]);
      if (row.outcome === "denied") return commandDenied(row);
      return commandApplied(row, {
        sourceRegistryId: commandResultText(row.result, "sourceRegistryId"),
        expiredCapabilities: commandResultStrings(row.result, "expiredCapabilities"),
      });
    });
  }

  lockAccount(accountId: string): Promise<void> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      guard.assertActive();
      if (metadata.accountId !== accountId) throw new Error("ACTOR_ACCOUNT_MISMATCH");
      if (metadata.actor.kind !== "system") {
        throw new Error("SYSTEM_AUTHORITY_REQUIRED");
      }
      await transaction.execute(
        sql`select syntholo_lock_scoped_system_account(${accountId})`,
      );
    });
  }
}

const state = new WeakMap<TransactionEntitlementRepository, Readonly<{
  guard: TransactionGuard;
  metadata: TrustedTransactionMetadata;
  transaction: DatabaseTransaction;
}>>();

export function databaseErrorCode(error: unknown): string | undefined {
  return pgCode(error);
}
