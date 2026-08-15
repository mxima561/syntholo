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
        acl_ready?: boolean;
        capability?: string | null;
        constraint_ready?: boolean;
        contract_version?: string;
        migration_count?: number;
        migration_created_at?: string;
        migration_hash?: string;
        migration_hashes?: string[];
        predicate_ready?: boolean;
        required_objects?: string[];
        runtime_role?: string;
        schema_version?: string;
        writer_compatibility_ready?: boolean;
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
    const foundation = await database.pool.query(
      "select schema_version, migration_count, migration_hashes, required_objects, runtime_role, capability from public.syntholo_runtime_readiness()",
    );
    const row = foundation.rows[0];
    const foundationMigrations = PUBLISHED_MIGRATIONS.slice(0, 7);
    if (
      foundation.rows.length !== 1
      || row === undefined
      || row.schema_version !== "0007_runtime_contract"
      || row.migration_count !== foundationMigrations.length
      || JSON.stringify(row.migration_hashes) !== JSON.stringify(
        foundationMigrations.map(({ hash }) => hash),
      )
      || JSON.stringify(row.required_objects) !== JSON.stringify(REQUIRED_RUNTIME_OBJECTS)
      || row.capability !== expectedCapability
      || row.runtime_role === undefined
      || row.runtime_role.trim() === ""
    ) {
      throw new Error("projection mismatch");
    }
    const accountName = await database.pool.query(
      "select contract_version, migration_created_at, migration_hash, predicate_ready, constraint_ready, writer_compatibility_ready, acl_ready from public.syntholo_account_name_readiness_v1()",
    );
    const accountNameRow = accountName.rows[0];
    const accountNameMigration = PUBLISHED_MIGRATIONS[7];
    if (
      accountName.rows.length !== 1
      || accountNameRow === undefined
      || accountNameMigration === undefined
      || accountNameRow.contract_version !== "0008_account_name.v1"
      || accountNameRow.migration_created_at !== String(accountNameMigration.when)
      || accountNameRow.migration_hash !== accountNameMigration.hash
      || accountNameRow.predicate_ready !== true
      || accountNameRow.constraint_ready !== true
      || accountNameRow.writer_compatibility_ready !== true
      || accountNameRow.acl_ready !== true
    ) {
      throw new Error("account-name projection mismatch");
    }
    return { latencyMs: Date.now() - started, status: "ok" };
  } catch {
    throw new Error("DATABASE_NOT_READY");
  }
}
