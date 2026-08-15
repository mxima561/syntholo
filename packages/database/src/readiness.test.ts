import { describe, expect, it, vi } from "vitest";
import { checkDatabaseReadiness } from "./readiness";

describe("database readiness projection", () => {
  const migrationHashes = [
    "bf3b66561107047f8c317d81bb561e9a29dc6207a14469a3ce588ec1f8ddc60c",
    "6508044b65dcce22b5d9a25b954a40768b813d84f943247e59f6c6391cec60a4",
    "5b1e18eeeb392048ebcd7436622c60702694758b84edc209afb91ba861b8d9da",
    "717c39300253771cbd09070c2b75297c0bfd788290c522877bbbf7293c4a7ea1",
    "b61002f28e9970c63ea24a291ebcca8711bdd1f1a178b9ce09910243cc6683b5",
    "6b465ae711125f441115f83dfbfe9bf63e92a74edd57190e357c10268adeafb5",
    "cc614367c67c41e46a22d951a5d413ce272e356b0fcd20d8ab0ab992d6727002",
    "505693d0977b3cf51b156ac792605be7bf6e4a5c89c5ead8d4c728d1c298f513",
  ];
  const requiredObjects = [
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
  ];
  const certificatesReady = {
    contract_version: "0013_certificates.v1",
    font_manifest_hash: "08b07f94c69e07cf51395aaa8057a4f5c2aebd1571fcf50e32baa89e9c881f96",
    function_acl_ready: true,
    function_ready: true,
    implementation_completion_is_authority: false,
    implementation_migration_hash: "dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9",
    immutability_ready: true,
    independence_ready: true,
    migration_created_at: "1786942800000",
    migration_hash: "878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9",
    policy_ready: true,
    public_execute_denied: true,
    receipt_binding_ready: true,
    rls_ready: true,
    structure_ready: true,
    table_acl_ready: true,
    table_ready: true,
    upstream_ready: true,
  } as const;
  const commerceReady = {
    catalog_ready: true,
    certificates_migration_hash: "878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9",
    cleanup_disabled: true,
    contract_version: "0014_commerce_catalog.v1",
    function_acl_ready: true,
    function_ready: true,
    implementation_completion_is_authority: false,
    implementation_migration_hash: "dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9",
    immutability_ready: true,
    independence_ready: true,
    migration_created_at: "1787029200000",
    migration_hash: "4bc124a641e6912d84fc6675133476f92e52e8fa89151079d05433d31deba8d4",
    policy_ready: true,
    public_execute_denied: true,
    rls_ready: true,
    structure_ready: true,
    table_acl_ready: true,
    table_ready: true,
    upstream_ready: true,
  } as const;

  function readyBeforeCertificates() {
    return [{
      capability: "syntholo_member_api",
      migration_count: 7,
      migration_hashes: migrationHashes.slice(0, 7),
      required_objects: requiredObjects,
      runtime_role: "syntholo_member_runtime",
      schema_version: "0007_runtime_contract",
    }, {
      acl_ready: true,
      constraint_ready: true,
      contract_version: "0008_account_name.v1",
      migration_created_at: "1786669200000",
      migration_hash: migrationHashes[7],
      predicate_ready: true,
      writer_compatibility_ready: true,
    }, {
      contract_version: "0009_content.v1",
      empty_catalog: true,
      function_acl_ready: true,
      immutable_triggers_ready: true,
      learning_acl_ready: true,
      learning_contract_version: "0011_learning.v1",
      learning_function_ready: true,
      learning_immutability_ready: true,
      learning_migration_created_at: "1786770000000",
      learning_migration_hash: "2e37ec9d4bfeee1ad0319ae81172fac4107a87c798bd2f0eed79eb75ee0e2ccf",
      learning_public_execute_denied: true,
      learning_rls_ready: true,
      learning_structure_ready: true,
      learning_table_ready: true,
      migration_created_at: "1786676400000",
      migration_hash: "2cf79d036accf426172ab2249e690e34c17a8f145c8e2afa72bb8e3994425922",
      object_count: 24,
      object_owner_ready: true,
      object_type_ready: true,
      public_execute_denied: true,
      table_acl_ready: true,
    }, {
      asset_table_ready: true,
      binding_ready: true,
      contract_version: "0010_content_assets.v1",
      empty_catalog: true,
      function_acl_ready: true,
      migration_created_at: "1786683600000",
      migration_hash: "65e621c5754cb490c50dff009854433815dae8ee3fd3a6410de9dea6080fcb43",
      public_execute_denied: true,
      receipt_constraint_ready: true,
      table_acl_ready: true,
      track_table_ready: true,
    }, {
      contract_version: "0012_implementation.v1",
      function_acl_ready: true,
      function_ready: true,
      immutability_ready: true,
      migration_created_at: "1786856400000",
      migration_hash: "dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9",
      policy_ready: true,
      public_execute_denied: true,
      receipt_binding_ready: true,
      rls_ready: true,
      seed_backfill_ready: true,
      structure_ready: true,
      table_acl_ready: true,
      table_ready: true,
      upstream_fk_ready: true,
    }];
  }

  it("keeps the 0007 foundation projection exact and requires the additive 0008 account-name contract", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          capability: "syntholo_member_api",
          migration_count: 7,
          migration_hashes: migrationHashes.slice(0, 7),
          required_objects: requiredObjects,
          runtime_role: "syntholo_member_runtime",
          schema_version: "0007_runtime_contract",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          acl_ready: true,
          constraint_ready: true,
          contract_version: "0008_account_name.v1",
          migration_created_at: "1786669200000",
          migration_hash: migrationHashes[7],
          predicate_ready: true,
          writer_compatibility_ready: true,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          function_acl_ready: true,
          immutable_triggers_ready: true,
          contract_version: "0009_content.v1",
          empty_catalog: true,
          migration_created_at: "1786676400000",
          migration_hash: "2cf79d036accf426172ab2249e690e34c17a8f145c8e2afa72bb8e3994425922",
          object_count: 24,
          object_owner_ready: true,
          object_type_ready: true,
          public_execute_denied: true,
          table_acl_ready: true,
          learning_acl_ready: true,
          learning_contract_version: "0011_learning.v1",
          learning_function_ready: true,
          learning_immutability_ready: true,
          learning_migration_created_at: "1786770000000",
          learning_migration_hash: "2e37ec9d4bfeee1ad0319ae81172fac4107a87c798bd2f0eed79eb75ee0e2ccf",
          learning_public_execute_denied: true,
          learning_rls_ready: true,
          learning_structure_ready: true,
          learning_table_ready: true,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          asset_table_ready: true,
          binding_ready: true,
          contract_version: "0010_content_assets.v1",
          empty_catalog: true,
          function_acl_ready: true,
          migration_created_at: "1786683600000",
          migration_hash: "65e621c5754cb490c50dff009854433815dae8ee3fd3a6410de9dea6080fcb43",
          public_execute_denied: true,
          receipt_constraint_ready: true,
          table_acl_ready: true,
          track_table_ready: true,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          contract_version: "0012_implementation.v1",
          migration_created_at: "1786856400000",
          migration_hash: "dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9",
          table_ready: true,
          structure_ready: true,
          immutability_ready: true,
          rls_ready: true,
          policy_ready: true,
          table_acl_ready: true,
          function_ready: true,
          function_acl_ready: true,
          public_execute_denied: true,
          receipt_binding_ready: true,
          upstream_fk_ready: true,
          seed_backfill_ready: true,
        }],
      })
      .mockResolvedValueOnce({
        rows: [certificatesReady],
      })
      .mockResolvedValueOnce({
        rows: [commerceReady],
      });

    await expect(checkDatabaseReadiness(
      { pool: { query } },
      "syntholo_member_api",
    )).resolves.toEqual({
      latencyMs: expect.any(Number),
      status: "ok",
    });
    expect(query).toHaveBeenNthCalledWith(1,
      "select schema_version, migration_count, migration_hashes, required_objects, runtime_role, capability from public.syntholo_runtime_readiness()",
    );
    expect(query).toHaveBeenNthCalledWith(2,
      "select contract_version, migration_created_at, migration_hash, predicate_ready, constraint_ready, writer_compatibility_ready, acl_ready from public.syntholo_account_name_readiness_v1()",
    );
    expect(query).toHaveBeenNthCalledWith(3,
      "select contract_version, migration_created_at, migration_hash, object_count, object_owner_ready, object_type_ready, immutable_triggers_ready, table_acl_ready, function_acl_ready, public_execute_denied, empty_catalog, learning_contract_version, learning_migration_created_at, learning_migration_hash, learning_table_ready, learning_structure_ready, learning_immutability_ready, learning_rls_ready, learning_acl_ready, learning_function_ready, learning_public_execute_denied from public.syntholo_content_readiness_v1()",
    );
    expect(query).toHaveBeenNthCalledWith(4,
      "select contract_version, migration_created_at, migration_hash, asset_table_ready, track_table_ready, binding_ready, receipt_constraint_ready, table_acl_ready, function_acl_ready, public_execute_denied, empty_catalog from public.syntholo_content_assets_readiness_v1()",
    );
    expect(query).toHaveBeenNthCalledWith(5,
      "select contract_version, migration_created_at, migration_hash, table_ready, structure_ready, immutability_ready, rls_ready, policy_ready, table_acl_ready, function_ready, function_acl_ready, public_execute_denied, receipt_binding_ready, upstream_fk_ready, seed_backfill_ready from public.syntholo_implementation_readiness_v1()",
    );
    expect(query).toHaveBeenNthCalledWith(6,
      "select contract_version, migration_created_at, migration_hash, implementation_migration_hash, implementation_completion_is_authority, font_manifest_hash, table_ready, structure_ready, immutability_ready, rls_ready, policy_ready, table_acl_ready, function_ready, function_acl_ready, public_execute_denied, receipt_binding_ready, upstream_ready, independence_ready from public.syntholo_certificates_readiness_v1()",
    );
    expect(query).toHaveBeenNthCalledWith(7,
      "select contract_version, migration_created_at, migration_hash, implementation_migration_hash, certificates_migration_hash, implementation_completion_is_authority, table_ready, structure_ready, immutability_ready, rls_ready, policy_ready, table_acl_ready, function_ready, function_acl_ready, public_execute_denied, upstream_ready, catalog_ready, cleanup_disabled, independence_ready from public.syntholo_commerce_catalog_readiness_v1()",
    );
  });

  it.each([
    { contract_version: "0014_commerce_catalog.v0" },
    { migration_created_at: "1787029199999" },
    { migration_hash: "f".repeat(64) },
    { implementation_migration_hash: "f".repeat(64) },
    { certificates_migration_hash: "f".repeat(64) },
    { implementation_completion_is_authority: true },
    { table_ready: false },
    { structure_ready: false },
    { immutability_ready: false },
    { rls_ready: false },
    { policy_ready: false },
    { table_acl_ready: false },
    { function_ready: false },
    { function_acl_ready: false },
    { public_execute_denied: false },
    { upstream_ready: false },
    { catalog_ready: false },
    { cleanup_disabled: false },
    { independence_ready: false },
  ])("fails a stale or weakened Commerce readiness projection closed", async (override) => {
    const query = vi.fn();
    for (const row of readyBeforeCertificates()) {
      query.mockResolvedValueOnce({ rows: [row] });
    }
    query.mockResolvedValueOnce({ rows: [certificatesReady] });
    query.mockResolvedValueOnce({ rows: [{ ...commerceReady, ...override }] });
    await expect(checkDatabaseReadiness(
      { pool: { query } },
      "syntholo_member_api",
    )).rejects.toThrow("DATABASE_NOT_READY");
  });

  it.each([
    { contract_version: "0013_certificates.v0" },
    { migration_created_at: "1786942799999" },
    { migration_hash: "f".repeat(64) },
    { implementation_migration_hash: "f".repeat(64) },
    { implementation_completion_is_authority: true },
    { font_manifest_hash: "f".repeat(64) },
    { table_ready: false },
    { structure_ready: false },
    { immutability_ready: false },
    { rls_ready: false },
    { policy_ready: false },
    { table_acl_ready: false },
    { function_ready: false },
    { function_acl_ready: false },
    { public_execute_denied: false },
    { receipt_binding_ready: false },
    { upstream_ready: false },
    { independence_ready: false },
  ])("fails a stale or weakened certificate readiness projection closed", async (override) => {
    const query = vi.fn();
    for (const row of readyBeforeCertificates()) {
      query.mockResolvedValueOnce({ rows: [row] });
    }
    query.mockResolvedValueOnce({ rows: [{ ...certificatesReady, ...override }] });
    await expect(checkDatabaseReadiness(
      { pool: { query } },
      "syntholo_member_api",
    )).rejects.toThrow("DATABASE_NOT_READY");
  });

  it("fails a missing or permissive additive content contract closed", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        capability: "syntholo_staff_api", migration_count: 7,
        migration_hashes: migrationHashes.slice(0, 7), required_objects: requiredObjects,
        runtime_role: "syntholo_staff_api", schema_version: "0007_runtime_contract",
      }] })
      .mockResolvedValueOnce({ rows: [{
        acl_ready: true, constraint_ready: true,
        contract_version: "0008_account_name.v1", migration_created_at: "1786669200000",
        migration_hash: migrationHashes[7], predicate_ready: true, writer_compatibility_ready: true,
      }] })
      .mockResolvedValueOnce({ rows: [{
        function_acl_ready: true, immutable_triggers_ready: true,
        contract_version: "0009_content.v1", empty_catalog: true,
        migration_created_at: "1786676400000", migration_hash: "2cf79d036accf426172ab2249e690e34c17a8f145c8e2afa72bb8e3994425922",
        object_count: 24, object_owner_ready: true, object_type_ready: true,
        public_execute_denied: true, table_acl_ready: false,
      }] });
    await expect(checkDatabaseReadiness({ pool: { query } }, "syntholo_staff_api"))
      .rejects.toThrow("DATABASE_NOT_READY");
  });

  it.each([
    { capability: "syntholo_staff_api", migration_count: 7, migration_hashes: migrationHashes, required_objects: requiredObjects, runtime_role: "member", schema_version: "0007_runtime_contract" },
    { capability: "syntholo_member_api", migration_count: 5, migration_hashes: migrationHashes.slice(0, 5), required_objects: requiredObjects, runtime_role: "member", schema_version: "0006_runtime_readiness" },
    { capability: "syntholo_member_api", migration_count: 7, migration_hashes: migrationHashes, required_objects: requiredObjects, runtime_role: "member", schema_version: "0005_entitlements" },
    { capability: "syntholo_member_api", migration_count: 7, migration_hashes: [...migrationHashes.slice(0, 2), "f".repeat(64), ...migrationHashes.slice(3)], required_objects: requiredObjects, runtime_role: "member", schema_version: "0007_runtime_contract" },
    { capability: "syntholo_member_api", migration_count: 7, migration_hashes: migrationHashes, required_objects: requiredObjects.slice(0, -1), runtime_role: "member", schema_version: "0007_runtime_contract" },
  ])("fails a stale or wrong-capability foundation projection closed", async (row) => {
    await expect(checkDatabaseReadiness(
      { pool: { query: async () => ({ rows: [row] }) } },
      "syntholo_member_api",
    )).rejects.toThrow("DATABASE_NOT_READY");
  });

  it.each([
    { migration_created_at: "1786669199999" },
    { migration_hash: "f".repeat(64) },
    { predicate_ready: false },
    { constraint_ready: false },
    { writer_compatibility_ready: false },
    { acl_ready: false },
  ])("fails a broken additive account-name contract closed", async (override) => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          capability: "syntholo_member_api",
          migration_count: 7,
          migration_hashes: migrationHashes.slice(0, 7),
          required_objects: requiredObjects,
          runtime_role: "syntholo_member_runtime",
          schema_version: "0007_runtime_contract",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          acl_ready: true,
          constraint_ready: true,
          contract_version: "0008_account_name.v1",
          migration_created_at: "1786669200000",
          migration_hash: migrationHashes[7],
          predicate_ready: true,
          writer_compatibility_ready: true,
          ...override,
        }],
      });

    await expect(checkDatabaseReadiness(
      { pool: { query } },
      "syntholo_member_api",
    )).rejects.toThrow("DATABASE_NOT_READY");
  });
});
