import { hasCapability, type GrantCapability, type GrantSource } from "@syntholo/domain";
import type { EntitlementStatus } from "@syntholo/domain/types";
import { getReadyDb } from "./client";

export type EntitlementGrantRecord = {
  id: string;
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
    userId: String(row.user_id),
    capability: row.capability as GrantCapability,
    status: row.status as EntitlementStatus,
    source: row.source as GrantSource,
    sourceId: row.source_id ? String(row.source_id) : null,
    startsAt: new Date(row.starts_at as string),
    endsAt: row.ends_at ? new Date(row.ends_at as string) : null,
  };
}

export async function listGrantsForUser(userId: string): Promise<EntitlementGrantRecord[]> {
  const db = await getReadyDb();
  const rows = await db`
    SELECT id, user_id, capability, status, source, source_id, starts_at, ends_at
    FROM entitlement_grants WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
  return rows.map(mapGrant);
}

export async function hasActiveCapability(userId: string, capability: GrantCapability, now = new Date()) {
  const grants = await listGrantsForUser(userId);
  return hasCapability(capability, grants, now);
}

export async function upsertEntitlementGrant(input: {
  userId: string;
  capability: GrantCapability;
  source: GrantSource;
  sourceId?: string | null;
  status?: EntitlementStatus;
  endsAt?: Date | null;
}): Promise<EntitlementGrantRecord> {
  const db = await getReadyDb();
  const status = input.status ?? "active";
  const sourceId = input.sourceId ?? null;
  const [existing] = await db`
    SELECT id, user_id, capability, status, source, source_id, starts_at, ends_at
    FROM entitlement_grants
    WHERE user_id = ${input.userId}
      AND capability = ${input.capability}
      AND status IN ('active', 'grace')
      AND source = ${input.source}
      AND COALESCE(source_id, '') = ${sourceId ?? ""}
    LIMIT 1
  `;
  if (existing) return mapGrant(existing);

  const [row] = await db`
    INSERT INTO entitlement_grants (user_id, capability, status, source, source_id, ends_at)
    VALUES (${input.userId}, ${input.capability}, ${status}, ${input.source}, ${sourceId}, ${input.endsAt ?? null})
    RETURNING id, user_id, capability, status, source, source_id, starts_at, ends_at
  `;
  return mapGrant(row);
}

export async function revokeEntitlementGrants(userId: string, capability: GrantCapability) {
  const db = await getReadyDb();
  await db`
    UPDATE entitlement_grants
    SET status = 'revoked'
    WHERE user_id = ${userId}
      AND capability = ${capability}
      AND status IN ('active', 'grace')
  `;
}

export async function refundGrantsForPurchase(purchaseId: string) {
  const db = await getReadyDb();
  await db`
    UPDATE entitlement_grants
    SET status = 'refunded'
    WHERE source = 'purchase'
      AND source_id = ${purchaseId}
      AND status IN ('active', 'grace')
  `;
}

export async function ensureDemoAcademyGrants(userId: string) {
  await upsertEntitlementGrant({ userId, capability: "academy_course", source: "demo" });
  await upsertEntitlementGrant({ userId, capability: "support", source: "demo" });
  await upsertEntitlementGrant({ userId, capability: "circle_write", source: "demo" });
}

export function supportWindowEnd(from = new Date()) {
  const ends = new Date(from);
  ends.setUTCFullYear(ends.getUTCFullYear() + 1);
  return ends;
}
