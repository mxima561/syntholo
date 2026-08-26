import { getReadyDb, type DatabaseClient } from "./client";
import type { SchoolRole } from "./permissions";

export type ActorKind = "member" | "staff" | "system";

export type MembershipLike = {
  id: string;
  accountId: string;
  userId: string;
  role: SchoolRole;
  status: "active" | "removed";
};

export async function withActorScope<T>(
  input: { actorKind: ActorKind; accountId?: string | null },
  work: (db: DatabaseClient) => Promise<T>,
  db?: DatabaseClient,
): Promise<T> {
  const sql = db ?? (await getReadyDb());
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor_kind', ${input.actorKind}, true)`;
    await tx`SELECT set_config('app.account_id', ${input.accountId ?? ""}, true)`;
    return work(tx as unknown as DatabaseClient);
  }) as Promise<T>;
}

export function withAccountScope<T>(
  accountId: string,
  work: (db: DatabaseClient) => Promise<T>,
  db?: DatabaseClient,
) {
  return withActorScope({ actorKind: "member", accountId }, work, db);
}

export function withStaffScope<T>(work: (db: DatabaseClient) => Promise<T>, db?: DatabaseClient) {
  return withActorScope({ actorKind: "staff" }, work, db);
}

export function withSystemScope<T>(work: (db: DatabaseClient) => Promise<T>, db?: DatabaseClient) {
  return withActorScope({ actorKind: "system" }, work, db);
}

export async function withUserAccountScope<T>(
  userId: string,
  work: (db: DatabaseClient, membership: MembershipLike) => Promise<T>,
): Promise<T> {
  const { ensureAccountForUser } = await import("./accounts");
  const membership = await withSystemScope((db) => ensureAccountForUser(userId, {}, db));
  return withAccountScope(membership.accountId, (db) => work(db, membership));
}
