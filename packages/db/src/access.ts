import {
  evaluateEntitlements,
  reservedSeatsFromCount,
  type EffectiveAccess,
  type GrantCapability,
} from "@syntholo/domain";
import type { DatabaseClient } from "./client";
import { occupiedSeatCount } from "./accounts";
import { listGrantsForAccount } from "./entitlements";
import { listAccountHolds } from "./holds";
import { withAccountScope } from "./scope";

export async function loadEffectiveAccess(
  accountId: string,
  now = new Date(),
  db?: DatabaseClient,
): Promise<EffectiveAccess> {
  const run = async (sql: DatabaseClient) => {
    const grants = await listGrantsForAccount(accountId, sql);
    const holds = await listAccountHolds(accountId, sql);
    const reservedSeats = await occupiedSeatCount(accountId, sql);
    return evaluateEntitlements({
      accountId,
      now,
      grants,
      holds,
      seats: reservedSeatsFromCount(reservedSeats),
    });
  };
  if (db) return run(db);
  return withAccountScope(accountId, run);
}

export async function hasActiveCapability(
  accountId: string,
  capability: GrantCapability,
  now = new Date(),
) {
  const access = await loadEffectiveAccess(accountId, now);
  return access.capabilities[capability];
}
