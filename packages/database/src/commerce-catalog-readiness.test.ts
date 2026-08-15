import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function migration(): Promise<string> {
  return readFile(new URL("../drizzle/0014_commerce_catalog.sql", import.meta.url), "utf8");
}

function functionBody(source: string, marker: string, delimiter: string): string {
  const markerOffset = source.indexOf(marker);
  const bodyOffset = source.indexOf(`AS ${delimiter}`, markerOffset);
  const endOffset = source.indexOf(`${delimiter};`, bodyOffset);
  expect(markerOffset).toBeGreaterThanOrEqual(0);
  expect(bodyOffset).toBeGreaterThanOrEqual(0);
  expect(endOffset).toBeGreaterThan(bodyOffset);
  return source.slice(bodyOffset + `AS ${delimiter}`.length, endOffset);
}

describe("0014 Commerce catalog readiness", () => {
  it("publishes one exact fail-closed readiness projection", async () => {
    const sql = await migration();
    expect(sql).toContain("CREATE FUNCTION public.syntholo_commerce_catalog_readiness_v1");
    expect(sql).toContain("contract_version text");
    expect(sql).toContain("migration_created_at bigint");
    expect(sql).toContain("migration_hash text");
    for (const flag of [
      "table_ready boolean",
      "structure_ready boolean",
      "immutability_ready boolean",
      "rls_ready boolean",
      "policy_ready boolean",
      "table_acl_ready boolean",
      "function_ready boolean",
      "function_acl_ready boolean",
      "public_execute_denied boolean",
      "upstream_ready boolean",
      "catalog_ready boolean",
      "cleanup_disabled boolean",
      "independence_ready boolean",
    ]) expect(sql).toContain(flag);
  });

  it("inventories every owned root and every catalog mutation dimension", async () => {
    const sql = await migration();
    const tables = [...sql.matchAll(/CREATE TABLE public\.([a-z][a-z0-9_]+)/gu)]
      .map((match) => match[1]!);
    expect(tables).toHaveLength(27);
    for (const table of tables) {
      const readiness = sql.slice(sql.indexOf(
        "CREATE FUNCTION public.syntholo_commerce_catalog_readiness_v1",
      ));
      expect(readiness).toContain(`'${table}'`);
    }
    for (const inventory of [
      "actual_columns",
      "actual_defaults",
      "actual_keys",
      "actual_fks",
      "actual_checks",
      "actual_indexes",
      "actual_triggers",
      "actual_policies",
      "actual_table_acl",
      "actual_column_acl",
      "actual_function_acl",
    ]) expect(sql).toContain(inventory);
    expect(sql).toContain("receipt_root_authority");
    expect(sql).toContain("provider_event_receipts_migrator");
    expect(sql).toContain("expected_offers");
    expect(sql).toContain("actual_offers");
  });

  it("uses exact portable catalog and function fingerprints with no placeholder authority", async () => {
    const sql = await migration();
    const readiness = sql.slice(sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_catalog_readiness_v1",
    ));
    expect(readiness).not.toContain("_PENDING");
    expect(readiness).toContain(
      "'ownerMatches',proowner=(SELECT proowner FROM owner)",
    );
    expect(readiness).toMatch(/value='[0-9a-f]{64}'/gu);
    expect(readiness).toMatch(/body_hash='[0-9a-f]{64}'/gu);
  });

  it("composes frozen upstream authority and explicitly denies cleanup and certificate coupling", async () => {
    const sql = await migration();
    expect(sql).toContain("public.syntholo_content_readiness_v1()");
    expect(sql).toContain("public.syntholo_implementation_readiness_v1()");
    expect(sql).toContain("public.syntholo_certificates_readiness_v1()");
    expect(sql).toContain("upstream_readiness_functions");
    expect(sql).toContain("actual_upstream_readiness_functions");
    expect(sql).toContain(
      "878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9",
    );
    expect(sql).toContain("COMMERCE_CLEANUP_NOT_ACTIVE");
    expect(sql).toContain("certificateNonAuthority=true");
    expect(sql).toContain("account_course_accesses_active_source_course_unique");
  });

  it("forward-replaces runtime and upstream readiness with only the exact Commerce allowlist delta", async () => {
    const [commerce, certificates] = await Promise.all([
      migration(),
      readFile(new URL("../drizzle/0013_certificates.sql", import.meta.url), "utf8"),
    ]);
    const runtimeMarker =
      "CREATE OR REPLACE FUNCTION public.syntholo_attest_runtime_capability";
    const oldRuntime = functionBody(certificates, runtimeMarker, "$fn$");
    const newRuntime = functionBody(commerce, runtimeMarker, "$fn$");
    const additions = [
      "          'syntholo_record_public_business_os_setup_reconciliation(uuid,uuid,text,text,timestamp with time zone,text,timestamp with time zone)',\n",
      "          'syntholo_commerce_catalog_readiness_v1()',\n",
      "          'syntholo_commerce_begin_checkout_action_v1(uuid,text,timestamp with time zone)',\n",
      "          'syntholo_commerce_claim_provider_event_v1(text,integer,timestamp with time zone)',\n",
      "          'syntholo_commerce_initiate_claim_v1(text,text,timestamp with time zone)',\n",
      "          'syntholo_commerce_redeem_claim_v1(text,uuid,text,text,text,bytea,timestamp with time zone)',\n",
      "          'syntholo_commerce_finish_checkout_action_v1(uuid,text,integer,text,text,timestamp with time zone)',\n",
      "          'syntholo_commerce_finish_provider_event_v1(uuid,text,uuid,integer,text,text,timestamp with time zone)',\n",
      "          'syntholo_commerce_record_provider_event_v1(text,text,boolean,text,timestamp with time zone,text,text,boolean,text,text,text,text,boolean,text,text,timestamp with time zone)',\n",
      "          'syntholo_commerce_publish_catalog_version_v1(uuid,text,text,timestamp with time zone)',\n",
      "          'syntholo_commerce_record_checkout_session_v1(uuid,text,integer,text,text,text,text,bytea,bytea,bytea,text,timestamp with time zone,timestamp with time zone)',\n",
      "          'syntholo_commerce_stage_checkout_action_v1(uuid,text,timestamp with time zone)',\n",
      "          'syntholo_commerce_stage_catalog_version_v1(text,text,jsonb,text,text,timestamp with time zone)',\n",
      "          'syntholo_commerce_stage_price_binding_v1(uuid,text,text,text,text,text,text,text,text,integer,text,integer,text,text,timestamp with time zone,timestamp with time zone)',\n",
      "          'syntholo_commerce_record_provider_effect_v1(uuid,text,text,uuid,integer,uuid,text,uuid,uuid,timestamp with time zone)',\n",
      "          'syntholo_commerce_record_paid_purchase_v1(uuid,text,uuid,integer,uuid,text,text,integer,integer,timestamp with time zone,uuid,timestamp with time zone)',\n",
      "          'syntholo_commerce_record_public_bos_setup_paid_v1(uuid,text,uuid,integer,uuid,uuid,text,text,text,integer,integer,timestamp with time zone,uuid,text,text,bytea,bytea,bytea,text,text,timestamp with time zone)',\n",
      "          'syntholo_commerce_record_public_self_paced_paid_v1(uuid,text,uuid,integer,uuid,text,text,integer,integer,timestamp with time zone,uuid,text,text,bytea,bytea,bytea,text,timestamp with time zone)',\n",
      "          'syntholo_commerce_reserve_existing_bos_setup_v1(uuid,uuid,text,text,text,uuid,uuid,text,text,jsonb,timestamp with time zone,timestamp with time zone)',\n",
      "          'syntholo_commerce_reserve_recurring_purchase_v1(uuid,uuid,text,text,text,text,text,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone)',\n",
      "          'syntholo_commerce_reserve_public_bos_setup_v1(text,text,text,text,uuid,uuid,bytea,bytea,text,text,bytea,bytea,bytea,text,bytea,bytea,bytea,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone)',\n",
      "          'syntholo_commerce_reserve_public_self_paced_v1(text,text,text,text,uuid,uuid,bytea,bytea,bytea,bytea,text,bytea,bytea,bytea,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone)',\n",
    ];
    expect(additions.reduce((body, addition) => body.replace(addition, ""), newRuntime))
      .toBe(oldRuntime);

    const runtimeHash = createHash("sha256").update(newRuntime).digest("hex");
    const implementationMarker =
      "CREATE OR REPLACE FUNCTION public.syntholo_implementation_readiness_v1";
    const oldImplementation = functionBody(
      certificates,
      implementationMarker,
      "$f$",
    );
    const newImplementation = functionBody(
      commerce,
      implementationMarker,
      "$f$",
    );
    const oldRuntimeHash = createHash("sha256").update(oldRuntime).digest("hex");
    expect(newImplementation).toContain(runtimeHash);
    expect(newImplementation.replace(runtimeHash, oldRuntimeHash)).toBe(oldImplementation);

    const oldImplementationHash = createHash("sha256")
      .update(oldImplementation)
      .digest("hex");
    const newImplementationHash = createHash("sha256")
      .update(newImplementation)
      .digest("hex");
    const certificateMarker =
      "FUNCTION public.syntholo_certificates_readiness_v1()";
    const oldCertificate = functionBody(certificates, certificateMarker, "$f$");
    const newCertificate = functionBody(commerce, certificateMarker, "$f$");
    expect(newCertificate).toContain(runtimeHash);
    expect(newCertificate).toContain(newImplementationHash);
    expect(newCertificate
      .replace(runtimeHash, oldRuntimeHash)
      .replace(newImplementationHash, oldImplementationHash))
      .toBe(oldCertificate);
  });
});
