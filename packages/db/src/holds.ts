import type { AccountHold, HoldKind } from "@syntholo/domain";
import type { DatabaseClient } from "./client";
import { withAccountScope, withSystemScope } from "./scope";

export const HOLD_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS account_holds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('commerce', 'seat_changes', 'business_os_activation')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_holds_active_kind_uidx
    ON account_holds (account_id, kind) WHERE active`,
];

export const ENTITLEMENT_CONSTRAINT_SQL = [
  `ALTER TABLE entitlement_grants DROP CONSTRAINT IF EXISTS entitlement_grants_interval_chk`,
  `DO $$ BEGIN
    ALTER TABLE entitlement_grants
      ADD CONSTRAINT entitlement_grants_interval_chk
      CHECK (ends_at IS NULL OR ends_at > starts_at);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
];

function mapHold(row: Record<string, unknown>): AccountHold & { id: string; reason: string; source: string } {
  return {
    id: String(row.id),
    kind: row.kind as HoldKind,
    active: Boolean(row.active),
    reason: String(row.reason ?? ""),
    source: String(row.source ?? ""),
  };
}

export async function listAccountHolds(accountId: string, db?: DatabaseClient) {
  const run = async (sql: DatabaseClient) => {
    const rows = await sql`
      SELECT id, kind, active, reason, source
      FROM account_holds
      WHERE account_id = ${accountId}
      ORDER BY created_at
    `;
    return rows.map(mapHold);
  };
  if (db) return run(db);
  return withAccountScope(accountId, run);
}

export async function setAccountHold(input: {
  accountId: string;
  kind: HoldKind;
  reason?: string;
  source?: string;
}, db?: DatabaseClient) {
  const run = async (sql: DatabaseClient) => {
    const [existing] = await sql`
      SELECT id FROM account_holds
      WHERE account_id = ${input.accountId} AND kind = ${input.kind} AND active
      LIMIT 1
    `;
    if (existing) return;
    await sql`
      INSERT INTO account_holds (account_id, kind, reason, source)
      VALUES (${input.accountId}, ${input.kind}, ${input.reason ?? ""}, ${input.source ?? ""})
    `;
  };
  if (db) return run(db);
  return withSystemScope(run);
}

export async function clearAccountHold(accountId: string, kind: HoldKind, db?: DatabaseClient) {
  const run = async (sql: DatabaseClient) => {
    await sql`
      UPDATE account_holds
      SET active = FALSE, updated_at = now()
      WHERE account_id = ${accountId} AND kind = ${kind} AND active
    `;
  };
  if (db) return run(db);
  return withSystemScope(run);
}
