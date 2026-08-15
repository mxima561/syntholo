import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const fixtureUrl = new URL("./certificates-handshake.json", import.meta.url);
const certificatesMigrationUrl = new URL("../../drizzle/0013_certificates.sql", import.meta.url);
const implementationMigrationUrl = new URL("../../drizzle/0012_implementation.sql", import.meta.url);
const learningMigrationUrl = new URL("../../drizzle/0011_learning.sql", import.meta.url);

describe("certificate schema handshake", () => {
  it("freezes the exact authority, storage, route, and 0027 consumer contract", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Record<string, unknown>;
    const [certificatesMigration, implementationMigration, learningMigration] = await Promise.all([
      readFile(certificatesMigrationUrl, "utf8"),
      readFile(implementationMigrationUrl, "utf8"),
      readFile(learningMigrationUrl, "utf8"),
    ]);
    expect(fixture).toEqual({
      schemaVersion: 1,
      migration: {
        index: 12,
        timestamp: 1786942800000,
        tag: "0013_certificates",
        sha256: "878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9",
      },
      learningAuthority: {
        migration: {
          index: 10,
          timestamp: 1786770000000,
          tag: "0011_learning",
          sha256: "2e37ec9d4bfeee1ad0319ae81172fac4107a87c798bd2f0eed79eb75ee0e2ccf",
        },
        completion: {
          table: "course_completions",
          primaryKey: ["id"],
          exactKey: ["id", "account_id", "membership_id", "enrollment_id", "course_id", "course_version_id"],
        },
        prerequisite: {
          table: "certificate_prerequisites",
          primaryKey: ["id"],
          completionUnique: ["course_completion_id"],
          exactKey: ["id", "course_completion_id", "account_id", "membership_id", "enrollment_id", "course_id", "course_version_id"],
        },
        event: { type: "learning.course_completed.v1", schemaVersion: 1 },
      },
      implementationAuthority: {
        migration: {
          index: 11,
          timestamp: 1786856400000,
          tag: "0012_implementation",
          sha256: "dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9",
        },
        implementationCompletionIsAuthority: false,
      },
      recipientName: {
        headTable: "certificate_recipient_name_heads",
        headPrimaryKey: ["account_id", "membership_id"],
        versionTable: "certificate_recipient_name_versions",
        versionPrimaryKey: ["id"],
        scopeVersionUnique: ["account_id", "membership_id", "version"],
        exactKey: ["id", "account_id", "membership_id", "version"],
        exactSnapshotKey: ["id", "account_id", "membership_id", "version", "display_name"],
        sourceReceiptUnique: ["source_command_receipt_id"],
        versionMembershipActorForeignKey: ["membership_id", "account_id", "actor_identity_id"],
        versionMembershipActorReferencedKey: ["id", "account_id", "member_identity_id"],
        versionActorAccountForeignKey: ["actor_identity_id", "account_id"],
        versionActorAccountReferencedKey: ["id", "account_id"],
        headMembershipForeignKey: ["membership_id", "account_id"],
        headMembershipReferencedKey: ["id", "account_id"],
        headCurrentVersionForeignKey: ["current_version_id", "account_id", "membership_id", "current_version"],
        headCurrentVersionReferencedKey: ["id", "account_id", "membership_id", "version"],
      },
      certificate: {
        table: "certificate_records",
        primaryKey: ["id"],
        completionUnique: ["course_completion_id"],
        prerequisiteUnique: ["certificate_prerequisite_id"],
        exactKey: ["id", "account_id", "membership_id", "course_completion_id"],
        completionForeignKey: ["course_completion_id", "account_id", "membership_id", "enrollment_id", "course_id", "course_version_id"],
        completionReferencedKey: ["id", "account_id", "membership_id", "enrollment_id", "course_id", "course_version_id"],
        prerequisiteForeignKey: ["certificate_prerequisite_id", "course_completion_id", "account_id", "membership_id", "enrollment_id", "course_id", "course_version_id"],
        prerequisiteReferencedKey: ["id", "course_completion_id", "account_id", "membership_id", "enrollment_id", "course_id", "course_version_id"],
        courseVersionForeignKey: ["course_version_id", "course_id", "course_version"],
        courseVersionReferencedKey: ["id", "course_id", "version"],
        recipientSnapshotForeignKey: ["recipient_name_version_id", "account_id", "membership_id", "recipient_name_version", "recipient_name_snapshot"],
        recipientSnapshotReferencedKey: ["id", "account_id", "membership_id", "version", "display_name"],
        statuses: ["awaiting_recipient_name", "pending", "failed", "issued"],
        failureCodes: ["snapshot_not_renderable", "render_failed", "storage_failed"],
      },
      file: {
        table: "certificate_files",
        primaryKey: ["id"],
        certificateUnique: ["certificate_id"],
        completionUnique: ["course_completion_id"],
        exactKey: ["id", "certificate_id", "account_id", "membership_id", "course_completion_id"],
        recordForeignKey: ["certificate_id", "account_id", "membership_id", "course_completion_id"],
        recordReferencedKey: ["id", "account_id", "membership_id", "course_completion_id"],
        objectPathTemplate: "certificates/v1/{accountId}/{courseCompletionId}.pdf",
        access: "private",
        contentType: "application/pdf",
        rendererVersion: "certificate-pdf.v1",
      },
      job: {
        queue: "default",
        type: "learning.course_completed.certificate.v1",
        idempotencyKeyTemplate: "certificate:{courseCompletionId}",
        priority: 0,
        maxAttempts: 5,
      },
      routes: [
        { method: "GET", path: "/v1/member/certificate-recipient-name", successStatus: 200 },
        { method: "PUT", path: "/v1/member/certificate-recipient-name", successStatus: 200 },
        { method: "GET", path: "/v1/member/certificates", successStatus: 200 },
        { method: "GET", path: "/v1/member/certificates/:certificateId/download", successStatus: 200, delivery: "authenticated_private_stream" },
        { method: "POST", path: "/v1/staff/certificates/:certificateId/deliveries", successStatus: 202, response: { status: "delivery_pending" } },
      ],
      deliveryConsumer0027: {
        plannedMigration: "0027_notifications",
        sourceTable: "certificate_delivery_requests",
        primaryKey: ["id"],
        exactKey: ["id", "certificate_id", "account_id", "membership_id"],
        sourceReceiptUnique: ["source_command_receipt_id"],
        recordForeignKey: ["certificate_id", "account_id", "membership_id"],
        recordReferencedKey: ["id", "account_id", "membership_id"],
        status: "delivery_pending",
        inputColumns: ["id", "certificate_id", "account_id", "membership_id", "staff_identity_id", "reason", "source_command_receipt_id", "correlation_id", "status", "created_at"],
        destinationOverrideAllowed: false,
        providerDeliveryAlreadyOccurred: false,
      },
    });

    expect(fixture.migration).toMatchObject({
      sha256: createHash("sha256").update(certificatesMigration).digest("hex"),
    });
    expect(fixture.learningAuthority).toMatchObject({
      migration: { sha256: createHash("sha256").update(learningMigration).digest("hex") },
    });
    expect(fixture.implementationAuthority).toMatchObject({
      migration: { sha256: createHash("sha256").update(implementationMigration).digest("hex") },
      implementationCompletionIsAuthority: false,
    });
    for (const required of [
      "certificate_prerequisites_exact_unique",
      "certificate_name_versions_scope_version_unique",
      "certificate_name_versions_membership_actor_fk FOREIGN KEY(membership_id,account_id,actor_identity_id) REFERENCES public.memberships(id,account_id,member_identity_id)",
      "certificate_name_versions_actor_account_fk FOREIGN KEY(actor_identity_id,account_id) REFERENCES public.member_identities(id,account_id)",
      "certificate_name_versions_snapshot_exact_unique",
      "certificate_name_versions_source_receipt_unique UNIQUE(source_command_receipt_id)",
      "certificate_recipient_name_heads_pkey PRIMARY KEY(account_id,membership_id)",
      "certificate_name_heads_membership_account_fk FOREIGN KEY(membership_id,account_id) REFERENCES public.memberships(id,account_id)",
      "certificate_name_heads_current_version_fk FOREIGN KEY(current_version_id,account_id,membership_id,current_version) REFERENCES public.certificate_recipient_name_versions(id,account_id,membership_id,version)",
      "certificate_records_completion_unique UNIQUE(course_completion_id)",
      "certificate_records_prerequisite_unique UNIQUE(certificate_prerequisite_id)",
      "certificate_records_exact_unique UNIQUE(id,account_id,membership_id,course_completion_id)",
      "certificate_records_completion_exact_fk FOREIGN KEY(course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id) REFERENCES public.course_completions(id,account_id,membership_id,enrollment_id,course_id,course_version_id)",
      "certificate_records_prerequisite_exact_fk FOREIGN KEY(certificate_prerequisite_id,course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id) REFERENCES public.certificate_prerequisites(id,course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id)",
      "certificate_records_course_version_exact_fk FOREIGN KEY(course_version_id,course_id,course_version) REFERENCES public.course_versions(id,course_id,version)",
      "certificate_records_recipient_name_version_fk FOREIGN KEY(recipient_name_version_id,account_id,membership_id,recipient_name_version,recipient_name_snapshot) REFERENCES public.certificate_recipient_name_versions(id,account_id,membership_id,version,display_name)",
      "certificate_files_certificate_unique UNIQUE(certificate_id)",
      "certificate_files_completion_unique UNIQUE(course_completion_id)",
      "certificate_files_exact_unique UNIQUE(id,certificate_id,account_id,membership_id,course_completion_id)",
      "certificate_files_record_exact_fk FOREIGN KEY(certificate_id,account_id,membership_id,course_completion_id) REFERENCES public.certificate_records(id,account_id,membership_id,course_completion_id)",
      "object_key='certificates/v1/'||account_id::text||'/'||course_completion_id::text||'.pdf'",
      "renderer_version='certificate-pdf.v1'",
      "'learning.course_completed.certificate.v1'",
      "'certificate:'||target.course_completion_id::text",
      "'/v1/member/certificate-recipient-name'",
      "'/v1/staff/certificates/:certificateId/deliveries'",
      "certificate_delivery_requests_source_receipt_unique UNIQUE(source_command_receipt_id)",
      "certificate_delivery_requests_exact_unique UNIQUE(id,certificate_id,account_id,membership_id)",
      "certificate_delivery_requests_record_exact_fk FOREIGN KEY(certificate_id,account_id,membership_id) REFERENCES public.certificate_records(id,account_id,membership_id)",
      "status='delivery_pending'",
    ]) expect(certificatesMigration).toContain(required);
    expect(learningMigration).toContain(
      "course_completions_exact_unique UNIQUE(id,account_id,membership_id,enrollment_id,course_id,course_version_id)",
    );
    expect(learningMigration).toContain("learning.course_completed.v1");
  });
});
