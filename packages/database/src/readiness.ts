import type { DatabaseCapability } from "./client.js";
import { PUBLISHED_MIGRATIONS } from "./migrations.js";

export const REQUIRED_RUNTIME_OBJECTS = Object.freeze([
  "public.access_decision_audit",
  "public.account_hold_sources",
  "public.account_holds",
  "public.accounts",
  "public.administrative_grant_restorations",
  "public.audit_events",
  "public.business_os_setup_receipts",
  "public.business_os_subscription_cancellations",
  "public.club_subscription_cancellations",
  "public.commerce_fulfillment_receipts",
  "public.commerce_reconciliations",
  "public.entitlement_commands",
  "public.entitlement_grants",
  "public.entitlement_sources",
  "public.event_handler_receipts",
  "public.job_attempts",
  "public.jobs",
  "public.member_identities",
  "public.memberships",
  "public.outbox_events",
  "public.provider_event_receipts",
  "public.seat_invitation_token_generations",
  "public.seat_invitations",
  "public.seat_reservations",
  "public.staff_identities",
  "public.staff_login_attempts",
  "public.staff_sessions",
] as const);

type ReadinessDatabase = Readonly<{
  pool: Readonly<{
    query(sql: string): Promise<Readonly<{
      rows: Array<{
        capability: string | null;
        migration_count: number;
        migration_hashes: string[];
        required_objects: string[];
        runtime_role: string;
        schema_version: string;
      }>;
    }>>;
  }>;
}>;

export async function checkDatabaseReadiness(
  database: ReadinessDatabase,
  expectedCapability: DatabaseCapability,
): Promise<Readonly<{ latencyMs: number; status: "ok" }>> {
  const started = Date.now();
  try {
    const result = await database.pool.query(
      "select schema_version, migration_count, migration_hashes, required_objects, runtime_role, capability from public.syntholo_runtime_readiness()",
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1
      || row === undefined
      || row.schema_version !== "0008_account_name"
      || row.migration_count !== PUBLISHED_MIGRATIONS.length
      || JSON.stringify(row.migration_hashes) !== JSON.stringify(
        PUBLISHED_MIGRATIONS.map(({ hash }) => hash),
      )
      || JSON.stringify(row.required_objects) !== JSON.stringify(REQUIRED_RUNTIME_OBJECTS)
      || row.capability !== expectedCapability
      || row.runtime_role.trim() === ""
    ) {
      throw new Error("projection mismatch");
    }
    return { latencyMs: Date.now() - started, status: "ok" };
  } catch {
    throw new Error("DATABASE_NOT_READY");
  }
}
