import type { Pool, PoolClient, QueryResult } from "pg";

export type MemberReadDeadlineKind =
  | "pool_acquire_timeout"
  | "query_timeout"
  | "parent_timeout"
  | "lock_timeout";

export const MEMBER_READ_DEADLINES = Object.freeze({
  cleanupMs: 1_000,
  lockMs: 2_000,
  parentMs: 8_000,
  poolAcquireMs: 2_000,
  queryMs: 5_000,
});

abstract class MemberReadDeadlineExceeded extends Error {
  abstract readonly kind: MemberReadDeadlineKind;
}

export class MemberReadPoolAcquireDeadlineExceeded
  extends MemberReadDeadlineExceeded {
  readonly kind = "pool_acquire_timeout" as const;
  constructor() {
    super("MEMBER_READ_POOL_ACQUIRE_DEADLINE_EXCEEDED");
    this.name = "MemberReadPoolAcquireDeadlineExceeded";
  }
}

export class MemberReadQueryDeadlineExceeded extends MemberReadDeadlineExceeded {
  readonly kind = "query_timeout" as const;
  constructor() {
    super("MEMBER_READ_QUERY_DEADLINE_EXCEEDED");
    this.name = "MemberReadQueryDeadlineExceeded";
  }
}

export class MemberReadParentDeadlineExceeded extends MemberReadDeadlineExceeded {
  readonly kind = "parent_timeout" as const;
  constructor() {
    super("MEMBER_READ_PARENT_DEADLINE_EXCEEDED");
    this.name = "MemberReadParentDeadlineExceeded";
  }
}

export class MemberReadLockDeadlineExceeded extends MemberReadDeadlineExceeded {
  readonly kind = "lock_timeout" as const;
  constructor() {
    super("MEMBER_READ_LOCK_DEADLINE_EXCEEDED");
    this.name = "MemberReadLockDeadlineExceeded";
  }
}

export class DatabaseDependencyUnavailableError extends Error {
  readonly code = "DATABASE_DEPENDENCY_UNAVAILABLE";
  constructor(readonly kind: MemberReadDeadlineKind) {
    super("DATABASE_DEPENDENCY_UNAVAILABLE");
    this.name = "DatabaseDependencyUnavailableError";
  }
}

type ReleasableClient = Pick<PoolClient, "query" | "release" | "once">;

export class MemberReadClientLease {
  private settled = false;
  private destructionAcknowledged: Promise<void> | undefined;

  constructor(readonly client: ReleasableClient) {}

  get destroyed(): boolean {
    return this.destructionAcknowledged !== undefined;
  }

  release(): void {
    if (this.settled) return;
    this.settled = true;
    this.client.release();
  }

  destroy(): Promise<void> {
    if (this.destructionAcknowledged !== undefined) {
      return this.destructionAcknowledged;
    }
    if (this.settled) return Promise.resolve();
    this.settled = true;
    this.destructionAcknowledged = new Promise((resolve) => {
      this.client.once("end", resolve);
    });
    this.client.release(true);
    return this.destructionAcknowledged;
  }
}

function delayUntil(deadline: number): number {
  return Math.max(0, deadline - performance.now());
}

function earlierDeadlineError(
  operationDeadline: number,
  parentDeadline: number,
  operationError: () => MemberReadDeadlineExceeded,
): MemberReadDeadlineExceeded {
  return parentDeadline <= operationDeadline
    ? new MemberReadParentDeadlineExceeded()
    : operationError();
}

export function memberReadParentDeadline(
  budgetMs = MEMBER_READ_DEADLINES.parentMs,
): number {
  return performance.now() + budgetMs;
}

export async function throwIfMemberReadDeadlineExpired(
  lease: MemberReadClientLease,
  parentDeadline: number,
  cleanupMs: number = MEMBER_READ_DEADLINES.cleanupMs,
): Promise<void> {
  if (performance.now() >= parentDeadline) {
    await destroyMemberReadLease(lease, cleanupMs);
    throw new MemberReadParentDeadlineExceeded();
  }
}

export async function throwMemberReadLockDeadlineExceeded(
  lease: MemberReadClientLease,
  cleanupMs: number = MEMBER_READ_DEADLINES.cleanupMs,
): Promise<never> {
  await destroyMemberReadLease(lease, cleanupMs);
  throw new MemberReadLockDeadlineExceeded();
}

export function isMemberReadDeadlineError(
  error: unknown,
): error is MemberReadDeadlineExceeded {
  return error instanceof MemberReadPoolAcquireDeadlineExceeded
    || error instanceof MemberReadQueryDeadlineExceeded
    || error instanceof MemberReadParentDeadlineExceeded
    || error instanceof MemberReadLockDeadlineExceeded;
}

export function translateMemberReadDependencyError(
  error: unknown,
): DatabaseDependencyUnavailableError {
  if (!isMemberReadDeadlineError(error)) {
    throw new Error("MEMBER_READ_DEPENDENCY_ERROR_NOT_TRANSLATABLE");
  }
  return new DatabaseDependencyUnavailableError(error.kind);
}

export function acquireMemberReadClient(
  pool: Pick<Pool, "connect">,
  poolDeadline: number,
  parentDeadline: number,
): Promise<MemberReadClientLease> {
  const effectiveDeadline = Math.min(poolDeadline, parentDeadline);
  const rawAcquisition = Promise.resolve().then(() => pool.connect());
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(earlierDeadlineError(
        poolDeadline,
        parentDeadline,
        () => new MemberReadPoolAcquireDeadlineExceeded(),
      ));
    }, delayUntil(effectiveDeadline));
    rawAcquisition.then(
      (client) => {
        if (settled) {
          client.release(true);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(new MemberReadClientLease(client));
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function boundedAcknowledgement(
  acknowledgement: Promise<unknown>,
  cleanupMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      acknowledgement,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, cleanupMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function destroyMemberReadLease(
  lease: MemberReadClientLease,
  cleanupMs: number = MEMBER_READ_DEADLINES.cleanupMs,
): Promise<void> {
  return boundedAcknowledgement(lease.destroy(), cleanupMs);
}

async function runMemberReadQueryWithDeadline<
  TRow extends Record<string, unknown>,
>(
  lease: MemberReadClientLease,
  operationDeadline: number,
  parentDeadline: number,
  text: string,
  values: readonly unknown[] = [],
  cleanupMs: number,
  operationError: () => MemberReadDeadlineExceeded,
): Promise<QueryResult<TRow>> {
  await throwIfMemberReadDeadlineExpired(lease, parentDeadline, cleanupMs);
  const rawQuery = Promise.resolve(lease.client.query<TRow>(text, [...values]));
  const effectiveDeadline = Math.min(operationDeadline, parentDeadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<MemberReadDeadlineExceeded>((resolve) => {
    timer = setTimeout(() => resolve(earlierDeadlineError(
      operationDeadline,
      parentDeadline,
      operationError,
    )), delayUntil(effectiveDeadline));
  });

  let winner:
    | { kind: "result"; result: QueryResult<TRow> }
    | { kind: "deadline"; error: MemberReadDeadlineExceeded };
  try {
    winner = await Promise.race([
      rawQuery.then((result) => ({ kind: "result" as const, result })),
      deadline.then((error) => ({ kind: "deadline" as const, error })),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (winner.kind === "result") return winner.result;

  const destroyed = lease.destroy();
  void rawQuery.catch(() => undefined);
  await boundedAcknowledgement(
    Promise.allSettled([destroyed, rawQuery]),
    cleanupMs,
  );
  throw winner.error;
}

export function runMemberReadQuery<TRow extends Record<string, unknown>>(
  lease: MemberReadClientLease,
  queryDeadline: number,
  parentDeadline: number,
  text: string,
  values: readonly unknown[] = [],
  cleanupMs: number = MEMBER_READ_DEADLINES.cleanupMs,
): Promise<QueryResult<TRow>> {
  return runMemberReadQueryWithDeadline(
    lease,
    queryDeadline,
    parentDeadline,
    text,
    values,
    cleanupMs,
    () => new MemberReadQueryDeadlineExceeded(),
  );
}

export function runMemberReadLockQuery<TRow extends Record<string, unknown>>(
  lease: MemberReadClientLease,
  lockDeadline: number,
  parentDeadline: number,
  text: string,
  values: readonly unknown[] = [],
  cleanupMs: number = MEMBER_READ_DEADLINES.cleanupMs,
): Promise<QueryResult<TRow>> {
  return runMemberReadQueryWithDeadline(
    lease,
    lockDeadline,
    parentDeadline,
    text,
    values,
    cleanupMs,
    () => new MemberReadLockDeadlineExceeded(),
  );
}

export async function runMemberReadCleanupQuery<
  TRow extends Record<string, unknown>,
>(
  lease: MemberReadClientLease,
  cleanupMs: number,
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<TRow>> {
  if (lease.destroyed) throw new Error("MEMBER_READ_LEASE_DESTROYED");
  const rawQuery = Promise.resolve(lease.client.query<TRow>(text, [...values]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let winner:
    | { kind: "result"; result: QueryResult<TRow> }
    | { kind: "timeout" };
  try {
    winner = await Promise.race([
      rawQuery.then((result) => ({ kind: "result" as const, result })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), cleanupMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (winner.kind === "result") return winner.result;
  void lease.destroy();
  void rawQuery.catch(() => undefined);
  throw new Error("MEMBER_READ_CLEANUP_UNCONFIRMED");
}
