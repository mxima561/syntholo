import { isDeepStrictEqual } from "node:util";
import {
  createDomainEvent,
  type DomainEvent,
  type DomainEventInput,
  type JsonObject,
} from "@syntholo/domain";
import { sql } from "drizzle-orm";
import { outboxEvents } from "../schema/index.js";
import type { DatabaseTransaction } from "../unit-of-work.js";
import { assertSafeOperationalPayload } from "../payload-policy.js";
import type {
  TransactionGuard,
  TrustedTransactionMetadata,
} from "./context.js";

function outboxConflict(): never {
  throw new Error("OUTBOX_EVENT_CONFLICT");
}

function postgresCode(error: unknown): string | undefined {
  let current = error;
  while (current instanceof Error) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

export class OutboxRepository {
  constructor(
    transaction: DatabaseTransaction,
    metadata: TrustedTransactionMetadata,
    guard: TransactionGuard,
  ) {
    state.set(this, { guard, metadata, transaction });
    Object.freeze(this);
  }

  create<TType extends string, TPayload extends JsonObject>(
    input: DomainEventInput<TType, TPayload>,
  ): DomainEvent<TType, TPayload> {
    const { guard, metadata } = state.get(this)!;
    guard.assertActive();
    return createDomainEvent(input, {
      accountId: metadata.accountId,
      occurredAt: metadata.clock.now(),
    });
  }

  enqueue(event: DomainEvent<string, JsonObject>): Promise<string> {
    const { guard, transaction } = state.get(this)!;
    return guard.run(async () => {
      const canonical = this.canonicalEvent(event);
      try {
        await transaction.insert(outboxEvents).values(this.values(canonical));
      } catch (error) {
        if (postgresCode(error) === "23505") return outboxConflict();
        throw error;
      }
      return canonical.eventId;
    });
  }

  enqueueOnce(event: DomainEvent<string, JsonObject>): Promise<string> {
    const { transaction } = state.get(this)!;
    const { guard, metadata } = state.get(this)!;
    return guard.run(async () => {
      const canonical = this.canonicalEvent(event);
      try {
        await transaction.execute(sql`
        select public.syntholo_enqueue_outbox_once(
          ${canonical.eventId}, ${canonical.accountId}, ${metadata.actor.kind},
          ${metadata.actor.actorId}, ${metadata.correlationId}, ${canonical.type},
          ${canonical.aggregateId}, ${new Date(canonical.occurredAt)}, ${canonical.payload}
        )
        `);
        return canonical.eventId;
      } catch (error) {
        if (postgresCode(error) === "23505") return outboxConflict();
        throw error;
      }
    });
  }

  private canonicalEvent(
    event: DomainEvent<string, JsonObject>,
  ): DomainEvent<string, JsonObject> {
    if (event.accountId !== state.get(this)!.metadata.accountId) outboxConflict();
    if (event.schemaVersion !== 1) outboxConflict();
    try {
      const canonical = createDomainEvent({
        aggregateId: event.aggregateId,
        eventId: event.eventId,
        payload: assertSafeOperationalPayload(event.payload),
        type: event.type,
      }, {
        accountId: event.accountId,
        occurredAt: new Date(event.occurredAt),
      });
      if (!isDeepStrictEqual(canonical, event)) outboxConflict();
      return canonical;
    } catch {
      return outboxConflict();
    }
  }

  private values(event: DomainEvent<string, JsonObject>) {
    const { metadata } = state.get(this)!;
    return {
      accountId: event.accountId,
      actorId: metadata.actor.actorId,
      actorType: metadata.actor.kind,
      aggregateId: event.aggregateId,
      correlationId: metadata.correlationId,
      availableAt: new Date(event.occurredAt),
      eventId: event.eventId,
      occurredAt: new Date(event.occurredAt),
      payload: assertSafeOperationalPayload(event.payload),
      schemaVersion: event.schemaVersion,
      type: event.type,
    };
  }

}

const state = new WeakMap<OutboxRepository, Readonly<{
  guard: TransactionGuard;
  metadata: TrustedTransactionMetadata;
  transaction: DatabaseTransaction;
}>>();
