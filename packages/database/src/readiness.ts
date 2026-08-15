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
        asset_table_ready?: boolean;
        binding_ready?: boolean;
        capability?: string | null;
        constraint_ready?: boolean;
        contract_version?: string;
        empty_catalog?: boolean;
        function_acl_ready?: boolean;
        immutable_triggers_ready?: boolean;
        learning_acl_ready?: boolean;
        learning_contract_version?: string;
        learning_function_ready?: boolean;
        learning_immutability_ready?: boolean;
        learning_migration_created_at?: string;
        learning_migration_hash?: string;
        learning_public_execute_denied?: boolean;
        learning_rls_ready?: boolean;
        learning_structure_ready?: boolean;
        learning_table_ready?: boolean;
        migration_count?: number;
        migration_created_at?: string;
        migration_hash?: string;
        migration_hashes?: string[];
        object_count?: number;
        object_owner_ready?: boolean;
        object_type_ready?: boolean;
        predicate_ready?: boolean;
        receipt_constraint_ready?: boolean;
        required_objects?: string[];
        runtime_role?: string;
        schema_version?: string;
        table_acl_ready?: boolean;
        track_table_ready?: boolean;
        public_execute_denied?: boolean;
        function_ready?: boolean;
        immutability_ready?: boolean;
        policy_ready?: boolean;
        receipt_binding_ready?: boolean;
        rls_ready?: boolean;
        seed_backfill_ready?: boolean;
        structure_ready?: boolean;
        table_ready?: boolean;
        upstream_fk_ready?: boolean;
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
    const content = await database.pool.query(
      "select contract_version, migration_created_at, migration_hash, object_count, object_owner_ready, object_type_ready, immutable_triggers_ready, table_acl_ready, function_acl_ready, public_execute_denied, empty_catalog, learning_contract_version, learning_migration_created_at, learning_migration_hash, learning_table_ready, learning_structure_ready, learning_immutability_ready, learning_rls_ready, learning_acl_ready, learning_function_ready, learning_public_execute_denied from public.syntholo_content_readiness_v1()",
    );
    const contentRow = content.rows[0];
    const contentMigration = PUBLISHED_MIGRATIONS[8];
    const learningMigration = PUBLISHED_MIGRATIONS[10];
    if (
      content.rows.length !== 1
      || contentRow === undefined
      || contentMigration === undefined
      || learningMigration === undefined
      || contentRow.contract_version !== "0009_content.v1"
      || contentRow.migration_created_at !== String(contentMigration.when)
      || contentRow.migration_hash !== contentMigration.hash
      || contentRow.object_count !== 24
      || contentRow.object_owner_ready !== true
      || contentRow.object_type_ready !== true
      || contentRow.immutable_triggers_ready !== true
      || contentRow.table_acl_ready !== true
      || contentRow.function_acl_ready !== true
      || contentRow.public_execute_denied !== true
      || typeof contentRow.empty_catalog !== "boolean"
      || contentRow.learning_contract_version !== "0011_learning.v1"
      || contentRow.learning_migration_created_at !== String(learningMigration.when)
      || contentRow.learning_migration_hash !== learningMigration.hash
      || contentRow.learning_table_ready !== true
      || contentRow.learning_structure_ready !== true
      || contentRow.learning_immutability_ready !== true
      || contentRow.learning_rls_ready !== true
      || contentRow.learning_acl_ready !== true
      || contentRow.learning_function_ready !== true
      || contentRow.learning_public_execute_denied !== true
    ) {
      throw new Error("content projection mismatch");
    }
    const contentAssets = await database.pool.query(
      "select contract_version, migration_created_at, migration_hash, asset_table_ready, track_table_ready, binding_ready, receipt_constraint_ready, table_acl_ready, function_acl_ready, public_execute_denied, empty_catalog from public.syntholo_content_assets_readiness_v1()",
    );
    const contentAssetsRow = contentAssets.rows[0];
    const contentAssetsMigration = PUBLISHED_MIGRATIONS[9];
    if (
      contentAssets.rows.length !== 1
      || contentAssetsRow === undefined
      || contentAssetsMigration === undefined
      || contentAssetsRow.contract_version !== "0010_content_assets.v1"
      || contentAssetsRow.migration_created_at !== String(contentAssetsMigration.when)
      || contentAssetsRow.migration_hash !== contentAssetsMigration.hash
      || contentAssetsRow.asset_table_ready !== true
      || contentAssetsRow.track_table_ready !== true
      || contentAssetsRow.binding_ready !== true
      || contentAssetsRow.receipt_constraint_ready !== true
      || contentAssetsRow.table_acl_ready !== true
      || contentAssetsRow.function_acl_ready !== true
      || contentAssetsRow.public_execute_denied !== true
      || typeof contentAssetsRow.empty_catalog !== "boolean"
    ) {
      throw new Error("content-assets projection mismatch");
    }
    const implementation = await database.pool.query(
      "select contract_version, migration_created_at, migration_hash, table_ready, structure_ready, immutability_ready, rls_ready, policy_ready, table_acl_ready, function_ready, function_acl_ready, public_execute_denied, receipt_binding_ready, upstream_fk_ready, seed_backfill_ready from public.syntholo_implementation_readiness_v1()",
    );
    const implementationRow = implementation.rows[0];
    const implementationMigration = PUBLISHED_MIGRATIONS[11];
    if (
      implementation.rows.length !== 1
      || implementationRow === undefined
      || implementationMigration === undefined
      || implementationRow.contract_version !== "0012_implementation.v1"
      || implementationRow.migration_created_at !== String(implementationMigration.when)
      || implementationRow.migration_hash !== implementationMigration.hash
      || implementationRow.table_ready !== true
      || implementationRow.structure_ready !== true
      || implementationRow.immutability_ready !== true
      || implementationRow.rls_ready !== true
      || implementationRow.policy_ready !== true
      || implementationRow.table_acl_ready !== true
      || implementationRow.function_ready !== true
      || implementationRow.function_acl_ready !== true
      || implementationRow.public_execute_denied !== true
      || implementationRow.receipt_binding_ready !== true
      || implementationRow.upstream_fk_ready !== true
      || implementationRow.seed_backfill_ready !== true
    ) throw new Error("implementation projection mismatch");
    return { latencyMs: Date.now() - started, status: "ok" };
  } catch {
    throw new Error("DATABASE_NOT_READY");
  }
}
