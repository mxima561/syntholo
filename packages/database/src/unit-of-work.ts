import { Buffer } from "node:buffer";
import { trustedActorAuthenticationTime } from "@syntholo/domain";
import { sql } from "drizzle-orm";
import { registerTrustedActorAuthentication } from
  "../../domain/src/identity/authentication.js";
import type { Database } from "./client.js";
import { AuditRepository } from "./repositories/audit.js";
import type { TrustedTransactionMetadata } from "./repositories/context.js";
import { TransactionCommerceRepository } from "./repositories/commerce.js";
import { OutboxRepository } from "./repositories/outbox.js";
import { TransactionAccountRepository } from "./repositories/transaction-accounts.js";
import {
  TransactionEntitlementRepository,
  type SystemDatabase,
} from "./repositories/entitlements.js";
import { assertDatabaseCapability } from "./client.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function assertCanonicalAccountId(accountId: string): void {
  if (!canonicalUuidPattern.test(accountId)) {
    throw new Error("ACCOUNT_ID_INVALID");
  }
}

export type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export interface TransactionContext {
  readonly accounts: TransactionAccountRepository;
  readonly audit: AuditRepository;
  readonly commerce: TransactionCommerceRepository;
  readonly outbox: OutboxRepository;
  readonly entitlements: TransactionEntitlementRepository;
}

export interface UnitOfWork {
  transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

class PostgresUnitOfWork implements UnitOfWork {
  constructor(
    private readonly database: Database,
    private readonly metadata: TrustedTransactionMetadata,
  ) {}

  transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.database.transaction(async (databaseTransaction) => {
      const transactionNow = this.metadata.clock.now();
      if (!Number.isFinite(transactionNow.getTime())) {
        throw new Error("TRANSACTION_CLOCK_INVALID");
      }
      const transactionMetadata = Object.freeze({
        ...this.metadata,
        clock: Object.freeze({ now: () => new Date(transactionNow) }),
      });
      await databaseTransaction.execute(
        sql`select set_config('app.account_id', ${this.metadata.accountId ?? ""}, true)`,
      );
      await databaseTransaction.execute(
        sql`select set_config('app.actor_id', ${this.metadata.actor.actorId}, true),
                   set_config('app.actor_kind', ${this.metadata.actor.kind}, true),
                   set_config('app.actor_role', ${this.metadata.actor.kind === "system"
                     ? ""
                     : this.metadata.actor.role}, true),
                   set_config('app.actor_permissions', ${this.metadata.actor.kind === "staff"
                     ? JSON.stringify(this.metadata.actor.permissions)
                     : "[]"}, true),
                   set_config('app.membership_id', ${this.metadata.actor.kind === "member"
                     ? this.metadata.actor.membershipId
                     : ""}, true),
                   set_config('app.authenticated_at', ${this.metadata.actor.kind === "system"
                     ? ""
                     : (() => {
                       const canonical = trustedActorAuthenticationTime(
                         this.metadata.actor,
                       );
                       return canonical === null ? "" : new Date(canonical).toISOString();
                     })()}, true),
                   set_config('app.correlation_id', ${this.metadata.correlationId}, true)`,
      );
      let active = true;
      let inFlight = 0;
      let unobserved = 0;
      const pending = new Set<Promise<unknown>>();
      const guard = {
        assertActive: () => {
          if (!active) throw new Error("TRANSACTION_CONTEXT_EXPIRED");
        },
        assertSettled: () => {
          if (inFlight !== 0 || unobserved !== 0) {
            for (const operation of pending) void operation.catch(() => undefined);
            throw new Error("TRANSACTION_OPERATION_NOT_AWAITED");
          }
        },
        run: <T>(operation: () => Promise<T>): Promise<T> => {
          if (!active) return Promise.reject(new Error("TRANSACTION_CONTEXT_EXPIRED"));
          inFlight += 1;
          unobserved += 1;
          const underlying = Promise.resolve().then(operation).finally(() => {
            inFlight -= 1;
            pending.delete(underlying);
          });
          pending.add(underlying);
          let observed = false;
          const markObserved = () => {
            if (!observed) {
              observed = true;
              unobserved -= 1;
            }
          };
          return Object.freeze({
            catch: <TResult = never>(onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null) => {
              markObserved();
              return underlying.catch(onRejected);
            },
            finally: (onFinally?: (() => void) | null) => {
              markObserved();
              return underlying.finally(onFinally ?? undefined);
            },
            then: <TResult1 = T, TResult2 = never>(
              onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
              onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) => {
              markObserved();
              return underlying.then(onFulfilled, onRejected);
            },
            [Symbol.toStringTag]: "Promise",
          }) as Promise<T>;
        },
      };
      const transaction = Object.freeze({
        accounts: new TransactionAccountRepository(
          databaseTransaction,
          transactionMetadata,
          guard,
        ),
        audit: new AuditRepository(databaseTransaction, transactionMetadata, guard),
        commerce: new TransactionCommerceRepository(
          databaseTransaction,
          transactionMetadata,
          guard,
        ),
        outbox: new OutboxRepository(databaseTransaction, transactionMetadata, guard),
        entitlements: new TransactionEntitlementRepository(
          databaseTransaction,
          transactionMetadata,
          guard,
        ),
      });
      try {
        const result = await run(transaction);
        guard.assertSettled();
        return result;
      } finally {
        active = false;
      }
    });
  }
}

function validateMetadata(metadata: TrustedTransactionMetadata): void {
  if (metadata.accountId !== null) assertCanonicalAccountId(metadata.accountId);
  if (!canonicalUuidPattern.test(metadata.correlationId)) {
    throw new Error("CORRELATION_ID_INVALID");
  }
  if (
    !["member", "staff", "system"].includes(metadata.actor.kind)
    || metadata.actor.actorId.trim() === ""
    || Buffer.byteLength(metadata.actor.actorId, "utf8") > 255
    || typeof metadata.clock.now !== "function"
  ) {
    throw new Error("TRANSACTION_METADATA_INVALID");
  }
  if (
    metadata.actor.kind === "member"
    && (metadata.accountId === null
      || metadata.actor.accountId !== metadata.accountId)
  ) {
    throw new Error("ACTOR_ACCOUNT_MISMATCH");
  }
  if (
    metadata.actor.kind !== "system"
    && !Number.isFinite(metadata.actor.authenticatedAt.getTime())
  ) {
    throw new Error("TRANSACTION_METADATA_INVALID");
  }
}

export function createUnitOfWork(
  database: Database,
  metadata: TrustedTransactionMetadata,
): UnitOfWork {
  try {
    validateMetadata(metadata);
    if (metadata.actor.kind === "system") {
      throw new Error("TRANSACTION_METADATA_INVALID");
    }
    const canonicalAuthentication = trustedActorAuthenticationTime(metadata.actor);
    const actor = metadata.actor.kind === "member"
      ? Object.freeze({
        accountId: metadata.actor.accountId,
        actorId: metadata.actor.actorId,
        authenticatedAt: new Date(metadata.actor.authenticatedAt),
        clerkUserId: metadata.actor.clerkUserId,
        kind: metadata.actor.kind,
        membershipId: metadata.actor.membershipId,
        role: metadata.actor.role,
      })
      : Object.freeze({
        actorId: metadata.actor.actorId,
        authenticatedAt: new Date(metadata.actor.authenticatedAt),
        kind: metadata.actor.kind,
        permissions: Object.freeze([...metadata.actor.permissions]),
        role: metadata.actor.role,
        staffId: metadata.actor.staffId,
        workosUserId: metadata.actor.workosUserId,
      });
    registerTrustedActorAuthentication(
      actor,
      canonicalAuthentication === null ? null : new Date(canonicalAuthentication),
    );
    const now = metadata.clock.now.bind(metadata.clock);
    return new PostgresUnitOfWork(database, Object.freeze({
      accountId: metadata.accountId,
      actor,
      clock: Object.freeze({ now }),
      correlationId: metadata.correlationId,
    }));
  } catch (error) {
    if (
      error instanceof Error
      && ["ACCOUNT_ID_INVALID", "ACTOR_ACCOUNT_MISMATCH", "CORRELATION_ID_INVALID"]
        .includes(error.message)
    ) {
      throw error;
    }
    throw new Error("TRANSACTION_METADATA_INVALID");
  }
}

const attestedSystemDatabases = new WeakSet<Database>();

export async function attestSystemDatabase(
  database: Database,
): Promise<SystemDatabase> {
  await assertDatabaseCapability(database, "syntholo_system_api");
  attestedSystemDatabases.add(database);
  return database as SystemDatabase;
}

export function createSystemUnitOfWork(
  database: SystemDatabase,
  metadata: TrustedTransactionMetadata,
): UnitOfWork {
  try {
    validateMetadata(metadata);
    if (metadata.actor.kind !== "system" || !attestedSystemDatabases.has(database)) {
      throw new Error("TRANSACTION_METADATA_INVALID");
    }
    const now = metadata.clock.now.bind(metadata.clock);
    return new PostgresUnitOfWork(database, Object.freeze({
      accountId: metadata.accountId,
      actor: Object.freeze({ ...metadata.actor }),
      clock: Object.freeze({ now }),
      correlationId: metadata.correlationId,
    }));
  } catch {
    throw new Error("TRANSACTION_METADATA_INVALID");
  }
}

/**
 * Runs trusted package/server code inside an account-scoped transaction.
 * Never pass an untrusted SQL, plugin, or user-supplied callback: the callback
 * receives the transaction and could deliberately overwrite PostgreSQL GUCs.
 */
export async function withAccountScope<T>(
  database: Database,
  accountId: string,
  run: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  assertCanonicalAccountId(accountId);
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('app.account_id', ${accountId}, true)`,
    );
    return run(transaction);
  });
}
