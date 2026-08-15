import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function loadCertificateMigration(): Promise<string | null> {
  return readFile(new URL("../drizzle/0013_certificates.sql", import.meta.url), "utf8")
    .catch(() => null);
}

describe("0013 certificate migration contract", () => {
  it("preserves the immutable implementation handshake and adds exactly five certificate tables", async () => {
    const implementation = await readFile(
      new URL("../drizzle/0012_implementation.sql", import.meta.url),
      "utf8",
    );
    expect(createHash("sha256").update(implementation).digest("hex"))
      .toBe("dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9");

    const sql = await loadCertificateMigration();
    expect(sql, "0013 certificate migration must exist").not.toBeNull();
    if (sql === null) return;
    expect([...sql.matchAll(/CREATE TABLE public\.(certificate_[a-z_]+)/gu)].map((match) => match[1]))
      .toEqual([
        "certificate_recipient_name_versions",
        "certificate_recipient_name_heads",
        "certificate_records",
        "certificate_files",
        "certificate_delivery_requests",
      ]);
    expect(sql).toContain("implementationCompletionIsAuthority=false");
    expect(sql).not.toMatch(/REFERENCES public\.implementation_/u);
  });

  it("closes actor-scoped names, snapshot safety, issuance, delivery, and readiness", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    for (const authority of [
      "syntholo_certificate_name_content_hash_valid_v1",
      "syntholo_certificate_record_state_valid_v1",
      "syntholo_certificate_recipient_name_valid_v1",
      "syntholo_certificate_business_snapshot_renderable_v1",
      "syntholo_certificate_course_snapshot_renderable_v1",
      "syntholo_certificate_stage_candidate_v1",
      "syntholo_certificate_confirm_recipient_name_v1",
      "syntholo_certificate_promote_v1",
      "syntholo_certificate_load_generation_fence_v1",
      "syntholo_certificate_finalize_v1",
      "syntholo_certificate_mark_failed_v1",
      "syntholo_certificate_storage_retry_candidates_v1",
      "syntholo_certificate_recovery_audit_valid_v1",
      "syntholo_certificate_retry_v1",
      "syntholo_certificate_recovery_reject_v1",
      "syntholo_certificate_create_delivery_v1",
      "syntholo_certificates_readiness_v1",
    ]) expect(sql).toContain(authority);
    expect(sql).toContain("certificate-recipient-name.v1");
    expect(sql).toContain("certificate-pdf.v1");
    expect(sql).toContain("snapshot_not_renderable");
    expect(sql).toContain("storage_failed");
    expect(sql).toContain("certificates/v1/");
    expect(sql).toContain("learning.course_completed.v1");
    expect(sql).toContain("learning.course_completed.certificate.v1");
    const certificateTables = sql.slice(
      sql.indexOf("CREATE TABLE public.certificate_recipient_name_versions"),
      sql.indexOf("CREATE FUNCTION public.syntholo_certificate_immutable_row_v1"),
    );
    expect(certificateTables).not.toMatch(/REFERENCES public\.implementation_/u);
  });

  it("serializes names and closes canonical SQL ingress without unsafe casts", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    const nameValidator = sql.slice(
      sql.indexOf("CREATE FUNCTION public.syntholo_certificate_recipient_name_valid_v1"),
      sql.indexOf("CREATE FUNCTION public.syntholo_certificate_business_snapshot_renderable_v1"),
    );
    expect(nameValidator).toMatch(/160.*5760.*8232.*8233.*8239.*8287.*12288/su);
    expect(nameValidator).toContain("BETWEEN 8192 AND 8202");

    const confirmation = sql.slice(
      sql.indexOf("CREATE FUNCTION public.syntholo_certificate_confirm_recipient_name_v1"),
      sql.indexOf("CREATE FUNCTION public.syntholo_certificate_recipient_name_get_v1"),
    );
    expect(confirmation).toContain("pg_advisory_xact_lock");
    expect(confirmation).toContain("hashtext(actor_account::text||':'||actor_membership::text)");
    expect(sql).toContain("hashtext(source.completion_account_id::text||':'||source.completion_membership_id::text)");
    expect(confirmation).not.toContain("hashtext(principal)");
    expect(confirmation.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      confirmation.indexOf("SELECT * INTO receipt"),
    );
    expect(confirmation).toContain("head.updated_at + interval '1 millisecond'");
    expect(confirmation).toContain("response_payload");
    expect(confirmation).not.toMatch(/response\s*=\s*response(?!_)/u);

    expect(sql).not.toContain("^[0-9a-f-]{36}$");
    expect(sql).not.toMatch(/(?:aggregate_id|payload[^\n]*)::uuid/u);
  });

  it("attests every granted runtime path and preserves prior readiness", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.syntholo_attest_runtime_capability");
    expect(sql).toContain("'syntholo_certificates_readiness_v1()'");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.syntholo_implementation_readiness_v1");

    for (const signature of [
      "syntholo_certificate_recipient_name_get_v1()",
      "syntholo_certificates_list_v1(timestamp with time zone,uuid,integer)",
      "syntholo_certificate_download_fence_v1(uuid)",
    ]) {
      const start = sql.indexOf(`CREATE FUNCTION public.${signature.split("(")[0]}`);
      const end = sql.indexOf("--> statement-breakpoint", start);
      expect(sql.slice(start, end)).toContain(
        "syntholo_attest_runtime_capability('syntholo_member_api')",
      );
    }
  });

  it("uses exact job authority, acknowledgement-idempotent exclusive finalization, and exact enqueue reconciliation", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    expect(sql).toContain("syntholo_certificate_lock_generation_fence_v1");
    expect(sql).toContain("syntholo_certificate_load_issued_file_v1");
    const loadFence = sql.slice(
      sql.indexOf("CREATE FUNCTION public.syntholo_certificate_load_generation_fence_v1"),
      sql.indexOf("CREATE FUNCTION public.syntholo_certificate_lock_generation_fence_v1"),
    );
    expect(loadFence).toContain("r.status IN('pending','issued','failed')");
    expect(sql).toContain("FOR UPDATE OF j,ja,r");
    expect(sql).toContain("j.account_id=r.account_id");
    expect(sql).toContain("CERTIFICATE_JOB_RECONCILIATION_REQUIRED");
    expect(sql).toContain("CERTIFICATE_JOB_ACK_MISMATCH");
    expect(sql).toContain("certificate_historical_candidate");
    expect(sql).toContain("IF stage_result='recorded' THEN");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.syntholo_claim_jobs(");
    expect(sql).toContain("j.type <> 'learning.course_completed.certificate.v1'");
    expect(sql).toContain("p_worker ~ '-certificate-v1$'");
    expect(sql.match(/p_worker_id~'-certificate-v1\$'/gu)).toHaveLength(3);
    expect(sql).toContain("body_hash='9ce584d3c189c1a822548071084d24de59f0bfb495c9c73c4a9cf856c2100891'");
  });

  it("uses established staff context and an unambiguous delivery receipt payload", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    const delivery = sql.slice(
      sql.indexOf("CREATE FUNCTION public.syntholo_certificate_create_delivery_v1"),
      sql.indexOf("CREATE FUNCTION public.syntholo_certificates_readiness_v1"),
    );
    expect(delivery).toContain("current_setting('app.actor_kind',true)<>'staff'");
    expect(delivery).toContain("current_setting('app.actor_id',true)");
    expect(delivery).not.toContain("app.staff_id");
    expect(delivery).toContain("response_payload");
    expect(delivery).not.toMatch(/response\s*=\s*response(?!_)/u);
  });

  it("revokes PUBLIC from every exact certificate function signature", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    const signatureKey = (signature: string) => {
      const open = signature.indexOf("(");
      const args = signature.slice(open + 1, -1).trim();
      return `${signature.slice(0, open)}/${args === "" ? 0 : args.split(",").length}`;
    };
    const created = [...sql.matchAll(
      /CREATE FUNCTION public\.(syntholo_certificate[a-z0-9_]*\([^)]*\))/gu,
    )].map((match) => signatureKey(match[1]!));
    const revoked = [...sql.matchAll(
      /REVOKE ALL ON FUNCTION ([^;]+) FROM PUBLIC;/gu,
    )].flatMap((match) => [...match[1]!.matchAll(
      /public\.(syntholo_certificate[a-z0-9_]*\([^)]*\))/gu,
    )].map((signature) => signatureKey(signature[1]!)));

    expect(created.length).toBeGreaterThan(0);
    expect(new Set(revoked)).toEqual(new Set(created));
    expect(created).toContain(
      "syntholo_certificate_lock_generation_fence_v1/5",
    );
    expect(created).toContain("syntholo_certificate_enqueue_v1/1");
  });

  it("rejects nullable closed-command inputs before predicates can become unknown", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    for (const guard of [
      "p_handler_name IS DISTINCT FROM 'learning.certificate_prerequisite_record'",
      "p_expected_version IS NULL",
      "p_idempotency_key IS NULL",
      "p_request_hash IS NULL",
      "p_limit IS NULL",
      "p_byte_length IS NULL",
      "p_sha256 IS NULL",
      "p_failure_code IS NULL",
      "syntholo_certificate_text_valid_v1(p_reason,2000,true) IS DISTINCT FROM true",
      "syntholo_certificate_etag_valid_v1(p_etag) IS DISTINCT FROM true",
    ]) expect(sql).toContain(guard);
  });

  it("loads recovery composites through PostgreSQL-safe single-row assignments", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    expect(sql).not.toContain("SELECT r,j,o.correlation_id INTO target,job,correlation");
    expect(sql.match(/SELECT r\.\* INTO target/gu)).toHaveLength(5);
    expect(sql.match(/SELECT \* INTO job FROM public\.jobs WHERE id=p_job_id;/gu)).toHaveLength(2);
  });

  it("attests the exact 0013 catalog, prior authorities, and its own journal tuple", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    const readiness = sql.slice(
      sql.indexOf("CREATE FUNCTION public.syntholo_certificates_readiness_v1"),
      sql.indexOf("REVOKE ALL ON FUNCTION public.syntholo_certificate_enqueue_v1", sql.indexOf("CREATE FUNCTION public.syntholo_certificates_readiness_v1")),
    );
    for (const authority of [
      "migration_created_at bigint,migration_hash text",
      "1786942800000",
      "expected_defaults",
      "expected_keys",
      "expected_fks",
      "expected_checks",
      "expected_indexes",
      "expected_triggers",
      "when_clause",
      "expected_policies",
      "expected_table_acl",
      "actual_column_acl",
      "expected_function_acl",
      "proisstrict",
      "proparallel",
      "actual_function_inventory",
      "pg_get_constraintdef",
      "pg_get_indexdef",
      "pg_get_triggerdef",
      "pg_get_functiondef",
      "pg_get_expr(p.polqual,p.polrelid)",
      "learning_migration_hash='2e37ec9d4bfeee1ad0319ae81172fac4107a87c798bd2f0eed79eb75ee0e2ccf'",
      "migration_hash='dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9'",
      "jobs_idempotency_key_unique",
      "api_command_receipts_scope_key_unique",
      "certificate_recipient_name_versi_source_command_receipt_id_fkey",
      "CASE WHEN role_oid.oid=0 THEN 'PUBLIC'",
      "constraint_type,column_names,definition",
      "implementation_|entitlement_|commerce_|product_|subscription_|support_|circle_|business_os_|club_subscription_|seat_|account_hold|account_course_access",
    ]) expect(readiness).toContain(authority);

    // PostgreSQL 18's exact pg_get_expr rendering is part of the signed
    // catalog contract. Keep SQL keyword case and UUID cast parentheses exact
    // while preserving the case of security-sensitive string literals.
    const readinessSqlLiteralView = readiness.replaceAll("\\'", "'");
    for (const checkDefinition of [
      "((byte_length>=1)AND(byte_length<=26214400))",
      "((renderer_version='certificate-pdf.v1')AND(course_version>0))",
      "(snapshot_renderable=(public.syntholo_certificate_business_snapshot_renderable_v1(business_name_snapshot)ANDpublic.syntholo_certificate_course_snapshot_renderable_v1(course_title_snapshot)))",
      "(object_key=(((('certificates/v1/'||(account_id))||'/')||(course_completion_id))||'.pdf'))",
    ]) expect(readinessSqlLiteralView).toContain(checkDefinition);
    expect(readiness).toContain("pg_get_expr(c.conbin,c.conrelid)");
    expect(readiness).not.toContain("lower(pg_get_expr(c.conbin,c.conrelid))");
    expect(readiness).not.toMatch(/count\(\*\)\s*>\s*=|count\(\*\)\s*>/u);
    expect(readiness).not.toContain("function_acl_ready boolean)\nLANGUAGE");
  });

  it("binds every non-readiness certificate function to its exact PostgreSQL body hash", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    const readinessStart = sql.indexOf(
      "expected_function_bodies(signature,security_definer,volatility,body_hash) AS (VALUES",
      sql.indexOf("CREATE FUNCTION public.syntholo_certificates_readiness_v1"),
    );
    const expectedRows = [
      ...sql.slice(readinessStart).matchAll(
        /\('public\.(syntholo_certificate[^']+)'.*?'([0-9a-f]{64})'\)/gu,
      ),
    ];
    expect(expectedRows).toHaveLength(29);

    for (const [, signature, expectedHash] of expectedRows) {
      const functionName = signature.slice(0, signature.indexOf("("));
      const functionStart = sql.indexOf(`FUNCTION public.${functionName}(`);
      const bodyStartMarker = sql.indexOf("AS $f$", functionStart);
      const bodyStart = bodyStartMarker + "AS $f$".length;
      const bodyEnd = sql.indexOf("$f$;", bodyStart);
      expect(functionStart, functionName).toBeGreaterThanOrEqual(0);
      expect(bodyStartMarker, functionName).toBeGreaterThan(functionStart);
      expect(bodyEnd, functionName).toBeGreaterThan(bodyStart);
      expect(createHash("sha256").update(sql.slice(bodyStart, bodyEnd)).digest("hex"))
        .toBe(expectedHash);
    }
  });

  it("binds the forward-replaced job claim capability fence to its exact PostgreSQL body", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.syntholo_claim_jobs(");
    const bodyStartMarker = sql.indexOf("AS $claim$", start);
    const bodyStart = bodyStartMarker + "AS $claim$".length;
    const bodyEnd = sql.indexOf("$claim$;", bodyStart);
    const actual = createHash("sha256").update(sql.slice(bodyStart, bodyEnd)).digest("hex");
    expect(actual).toBe("9ce584d3c189c1a822548071084d24de59f0bfb495c9c73c4a9cf856c2100891");
    expect(sql).toContain(`body_hash='${actual}'`);
  });

  it("attests the exact strictness and parallel-safety declared by certificate routines", async () => {
    const sql = await loadCertificateMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    const helpers = sql.slice(
      sql.indexOf("CREATE FUNCTION public.syntholo_certificate_font_supports_v1"),
      sql.indexOf("CREATE TABLE public.certificate_recipient_name_versions"),
    );
    expect(helpers.match(/STRICT PARALLEL SAFE/gu)).toHaveLength(6);
    expect(helpers.match(/PARALLEL SAFE/gu)).toHaveLength(10);
    const expectedMetadata = sql.slice(
      sql.indexOf("expected_functions AS (", sql.indexOf("CREATE FUNCTION public.syntholo_certificates_readiness_v1")),
      sql.indexOf("  functions AS (", sql.indexOf("CREATE FUNCTION public.syntholo_certificates_readiness_v1")),
    );
    for (const helper of [
      "syntholo_certificate_font_supports_v1(integer)",
      "syntholo_certificate_forbidden_scalar_v1(integer)",
      "syntholo_certificate_recipient_name_valid_v1(text)",
      "syntholo_certificate_business_snapshot_renderable_v1(text)",
      "syntholo_certificate_course_snapshot_renderable_v1(text)",
      "syntholo_certificate_etag_valid_v1(text)",
    ]) expect(expectedMetadata).toContain(helper);
    expect(sql).toContain("proisstrict=is_strict");
    expect(sql).toContain("proparallel=parallel_safety");
  });
});
