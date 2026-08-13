import type { JsonObject } from "@syntholo/domain";
import { randomUUID } from "node:crypto";
import { auditEvents } from "../schema/index.js";
import type { DatabaseTransaction } from "../unit-of-work.js";
import { assertSafeAuditPayload } from "../payload-policy.js";
import type {
  TransactionGuard,
  TrustedTransactionMetadata,
} from "./context.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

export type AuditEventInput = Readonly<{
  action: string;
  payload?: JsonObject;
  targetId?: string | null;
  targetType: string;
}>;

export class AuditRepository {
  constructor(
    transaction: DatabaseTransaction,
    metadata: TrustedTransactionMetadata,
    guard: TransactionGuard,
  ) {
    state.set(this, { guard, metadata, transaction });
    Object.freeze(this);
  }

  append(event: AuditEventInput): Promise<string> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      if (
        !identifierPattern.test(event.action)
        || !identifierPattern.test(event.targetType)
        || (event.targetId !== undefined
          && event.targetId !== null
          && !identifierPattern.test(event.targetId))
      ) throw new Error("AUDIT_EVENT_INVALID");
      const payload = assertSafeAuditPayload(event.payload ?? {});
      const occurredAt = metadata.clock.now();
      if (!Number.isFinite(occurredAt.getTime())) throw new Error("AUDIT_EVENT_INVALID");
      const id = randomUUID();
      await transaction.insert(auditEvents).values({
        id, accountId: metadata.accountId, actorId: metadata.actor.actorId,
        actorType: metadata.actor.kind, action: event.action,
        correlationId: metadata.correlationId, occurredAt, payload,
        targetId: event.targetId ?? null, targetType: event.targetType,
      });
      return id;
    });
  }
}

const state = new WeakMap<AuditRepository, Readonly<{
  guard: TransactionGuard;
  metadata: TrustedTransactionMetadata;
  transaction: DatabaseTransaction;
}>>();
