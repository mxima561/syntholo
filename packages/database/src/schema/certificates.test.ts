import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFile } from "node:fs/promises";

async function loadCertificateSchema() {
  return import("./certificates.js").catch(() => null);
}

describe("certificate persistence schema", () => {
  it("publishes exact name, certificate, file, and delivery ownership", async () => {
    const schema = await loadCertificateSchema();
    expect(schema, "certificate schema must exist").not.toBeNull();
    if (schema === null) return;

    expect(Object.keys(schema).sort()).toEqual([
      "certificateDeliveryRequests",
      "certificateFiles",
      "certificateRecipientNameHeads",
      "certificateRecipientNameVersions",
      "certificateRecords",
    ]);
    expect(schema.certificateRecipientNameVersions.displayName.name).toBe("display_name");
    expect(schema.certificateRecipientNameHeads.currentVersionId.name).toBe("current_version_id");
    expect(schema.certificateRecords.snapshotRenderable.name).toBe("snapshot_renderable");
    expect(schema.certificateFiles.objectKey.name).toBe("object_key");
    expect(schema.certificateDeliveryRequests.status.name).toBe("status");

    const versions = getTableConfig(schema.certificateRecipientNameVersions);
    const heads = getTableConfig(schema.certificateRecipientNameHeads);
    const records = getTableConfig(schema.certificateRecords);
    const files = getTableConfig(schema.certificateFiles);
    const deliveries = getTableConfig(schema.certificateDeliveryRequests);

    expect(versions.uniqueConstraints.map(({ name }) => name).sort()).toEqual([
      "certificate_name_versions_exact_unique",
      "certificate_name_versions_scope_version_unique",
      "certificate_name_versions_snapshot_exact_unique",
      "certificate_name_versions_source_receipt_unique",
    ]);
    expect(heads.primaryKeys.map(({ name }) => name)).toEqual(["certificate_recipient_name_heads_pkey"]);
    expect(heads.foreignKeys.map((key) => key.getName()).sort()).toContain(
      "certificate_name_heads_current_version_fk",
    );
    expect(records.uniqueConstraints.map(({ name }) => name).sort()).toEqual([
      "certificate_records_completion_unique",
      "certificate_records_exact_unique",
      "certificate_records_member_exact_unique",
      "certificate_records_prerequisite_unique",
    ]);
    expect(files.uniqueConstraints.map(({ name }) => name).sort()).toEqual([
      "certificate_files_certificate_unique",
      "certificate_files_completion_unique",
      "certificate_files_exact_unique",
    ]);
    expect(deliveries.uniqueConstraints.map(({ name }) => name)).toContain(
      "certificate_delivery_requests_source_receipt_unique",
    );
  });

  it("mirrors the closed lifecycle, canonical hashes, private object, and safe projection checks", async () => {
    const schema = await loadCertificateSchema();
    expect(schema).not.toBeNull();
    if (schema === null) return;

    const checks = (table: Parameters<typeof getTableConfig>[0]) =>
      getTableConfig(table).checks.map(({ name }) => name).sort();
    expect(checks(schema.certificateRecipientNameVersions)).toEqual([
      "certificate_name_versions_content_hash_check",
      "certificate_name_versions_display_name_check",
      "certificate_name_versions_version_check",
    ]);
    expect(checks(schema.certificateRecipientNameHeads)).toEqual([
      "certificate_name_heads_version_check",
    ]);
    expect(checks(schema.certificateRecords)).toEqual([
      "certificate_records_renderer_check",
      "certificate_records_snapshot_renderability_check",
      "certificate_records_state_check",
    ]);
    expect(checks(schema.certificateFiles)).toEqual([
      "certificate_files_access_check",
      "certificate_files_byte_length_check",
      "certificate_files_content_type_check",
      "certificate_files_etag_check",
      "certificate_files_hash_check",
      "certificate_files_object_key_check",
      "certificate_files_renderer_check",
    ]);
    expect(checks(schema.certificateDeliveryRequests)).toEqual([
      "certificate_delivery_requests_reason_check",
      "certificate_delivery_requests_status_check",
    ]);
  });

  it("mirrors millisecond canonical defaults instead of driver-dependent now defaults", async () => {
    const source = await readFile(new URL("./certificates.ts", import.meta.url), "utf8");
    expect(source).not.toContain(".defaultNow()");
    expect(source.match(/date_trunc\('milliseconds',clock_timestamp\(\)\)/gu)).toHaveLength(7);
  });
});
