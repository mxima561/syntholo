import type { GrantCapability, GrantSource } from "@syntholo/domain";
import type { EntitlementStatus } from "@syntholo/domain/types";
import type { DatabaseClient } from "./client";
import { withAccountScope, withSystemScope, withUserAccountScope } from "./scope";

export type EntitlementGrantRecord = {
  id: string;
  accountId: string;
  userId: string;
  capability: GrantCapability;
  status: EntitlementStatus;
  source: GrantSource;
  sourceId: string | null;
  startsAt: Date;
  endsAt: Date | null;
};

function mapGrant(row: Record<string, unknown>): EntitlementGrantRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id ?? ""),
    userId: String(row.user_id),
    capability: row.capability as GrantCapability,
    status: row.status as EntitlementStatus,
    source: row.source as GrantSource,
    sourceId: row.source_id ? String(row.source_id) : null,
    startsAt: new Date(row.starts_at as string),
    endsAt: row.ends_at ? new Date(row.ends_at as string) : null,
  };
}

export async function listGrantsForAccount(accountId: string, db?: DatabaseClient): Promise<EntitlementGrantRecord[]> {
  const run = async (sql: DatabaseClient) => {
    const rows = await sql`
      SELECT id, account_id, user_id, capability, status, source, source_id, starts_at, ends_at
      FROM entitlement_grants WHERE account_id = ${accountId}
      ORDER BY created_at DESC
    `;
    return rows.map(mapGrant);
  };
  if (db) return run(db);
  return withAccountScope(accountId, run);
}

export async function listGrantsForUser(userId: string): Promise<EntitlementGrantRecord[]> {
  return withUserAccountScope(userId, (db, membership) => listGrantsForAccount(membership.accountId, db));
}

export async function upsertEntitlementGrant(
  input: {
    accountId: string;
    userId: string;
    capability: GrantCapability;
    source: GrantSource;
    sourceId?: string | null;
    status?: EntitlementStatus;
    endsAt?: Date | null;
  },
  db?: DatabaseClient,
): Promise<EntitlementGrantRecord> {
  const run = async (sql: DatabaseClient) => {
    const status = input.status ?? "active";
    const sourceId = input.sourceId ?? null;
    const [existing] = await sql`
      SELECT id, account_id, user_id, capability, status, source, source_id, starts_at, ends_at
      FROM entitlement_grants
      WHERE account_id = ${input.accountId}
        AND capability = ${input.capability}
        AND status IN ('active', 'grace')
        AND source = ${input.source}
        AND COALESCE(source_id, '') = ${sourceId ?? ""}
      LIMIT 1
    `;
    if (existing) return mapGrant(existing);

    const [row] = await sql`
      INSERT INTO entitlement_grants (account_id, user_id, capability, status, source, source_id, ends_at)
      VALUES (${input.accountId}, ${input.userId}, ${input.capability}, ${status}, ${input.source}, ${sourceId}, ${input.endsAt ?? null})
      RETURNING id, account_id, user_id, capability, status, source, source_id, starts_at, ends_at
    `;
    return mapGrant(row);
  };
  if (db) return run(db);
  return withSystemScope(run);
}

export async function revokeEntitlementGrants(accountId: string, capability: GrantCapability, db?: DatabaseClient) {
  const run = async (sql: DatabaseClient) => {
    await sql`
      UPDATE entitlement_grants
      SET status = 'revoked'
      WHERE account_id = ${accountId}
        AND capability = ${capability}
        AND status IN ('active', 'grace')
    `;
  };
  if (db) return run(db);
  return withSystemScope(run);
}

export async function refundGrantsForPurchase(purchaseId: string, db?: DatabaseClient) {
  const run = async (sql: DatabaseClient) => {
    await sql`
      UPDATE entitlement_grants
      SET status = 'refunded'
      WHERE source = 'purchase'
        AND source_id = ${purchaseId}
        AND status IN ('active', 'grace')
    `;
  };
  if (db) return run(db);
  return withSystemScope(run);
}

export async function ensureDemoAcademyGrants(accountId: string, userId: string) {
  await withSystemScope(async (db) => {
    await upsertEntitlementGrant({ accountId, userId, capability: "academy_course", source: "demo" }, db);
    await upsertEntitlementGrant({ accountId, userId, capability: "support", source: "demo" }, db);
    await upsertEntitlementGrant({ accountId, userId, capability: "circle_write", source: "demo" }, db);
  });
}

/** Lets active Syntholo staff open the student academy to operate and QA it. */
export async function ensureStaffAcademyGrants(accountId: string, userId: string) {
  await withSystemScope(async (db) => {
    await upsertEntitlementGrant({ accountId, userId, capability: "academy_course", source: "admin" }, db);
    await upsertEntitlementGrant({ accountId, userId, capability: "support", source: "admin" }, db);
    await upsertEntitlementGrant({ accountId, userId, capability: "circle_write", source: "admin" }, db);
  });
}

export function supportWindowEnd(from = new Date()) {
  const ends = new Date(from);
  ends.setUTCFullYear(ends.getUTCFullYear() + 1);
  return ends;
}
