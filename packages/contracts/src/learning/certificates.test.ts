import { describe, expect, it } from "vitest";

async function loadCertificateContracts() {
  return import("./certificates.js").catch(() => null);
}

const certificateId = "10000000-0000-4000-8000-000000000001";
const completionId = "10000000-0000-4000-8000-000000000002";

describe("certificate HTTP contracts", () => {
  it("accepts only canonical member-confirmed recipient names", async () => {
    const contracts = await loadCertificateContracts();
    expect(contracts, "certificate contracts must exist").not.toBeNull();
    if (contracts === null) return;

    expect(contracts.ConfirmCertificateRecipientNameRequestSchema.parse({
      expectedVersion: 0,
      displayName: "Zoë 李",
    })).toEqual({ expectedVersion: 0, displayName: "Zoë 李" });
    for (const displayName of [
      "",
      "nul\u0000name",
      "\ud800",
      "\udc00",
      "😀".repeat(121),
    ]) {
      expect(contracts.ConfirmCertificateRecipientNameRequestSchema.safeParse({
        expectedVersion: 0,
        displayName,
      }).success).toBe(false);
    }
    expect(contracts.ConfirmCertificateRecipientNameRequestSchema.parse({
      expectedVersion: 0,
      displayName: " \tZoe\u0308\u00a0\u00a0李 ",
    })).toEqual({ expectedVersion: 0, displayName: "Zoë 李" });
    expect(contracts.ConfirmCertificateRecipientNameRequestSchema.safeParse({
      expectedVersion: 0,
      displayName: `${" ".repeat(257)}Ada`,
    }).success).toBe(false);
    expect(contracts.ConfirmCertificateRecipientNameRequestSchema.safeParse({
      expectedVersion: 0,
      displayName: "😀".repeat(120),
    }).success).toBe(true);
    expect(contracts.ConfirmCertificateRecipientNameRequestSchema.parse({
      expectedVersion: 0,
      displayName: "Zoe\u0308",
    })).toEqual({ expectedVersion: 0, displayName: "Zoë" });
    for (const forbidden of ["A\u007fB", "A\u0080B", "A\u061cB", "A\u202eB", "A\ufdd0B", "A\ufffeB", "A\ue000B"]) {
      expect(contracts.ConfirmCertificateRecipientNameRequestSchema.safeParse({
        expectedVersion: 0,
        displayName: forbidden,
      }).success).toBe(false);
    }
    for (const supported of ["ليلى", "आशा", "שירה", "Zoë 李", "𐐀𐐨𐑅"]) {
      expect(contracts.ConfirmCertificateRecipientNameRequestSchema.safeParse({
        expectedVersion: 0,
        displayName: supported,
      }).success).toBe(true);
    }
    expect(contracts.ConfirmCertificateRecipientNameRequestSchema.safeParse({
      expectedVersion: 0,
      displayName: "Zoë 李",
      email: "must-not-be-accepted@example.com",
    }).success).toBe(false);
  });

  it("keeps optimistic name versions int4-safe and response heads coherent", async () => {
    const contracts = await loadCertificateContracts();
    expect(contracts).not.toBeNull();
    if (contracts === null) return;

    expect(contracts.ConfirmCertificateRecipientNameRequestSchema.safeParse({
      expectedVersion: 2_147_483_646,
      displayName: "Ada Lovelace",
    }).success).toBe(true);
    expect(contracts.ConfirmCertificateRecipientNameRequestSchema.safeParse({
      expectedVersion: 2_147_483_647,
      displayName: "Ada Lovelace",
    }).success).toBe(false);
    expect(contracts.CertificateRecipientNameResponseSchema.safeParse({
      schemaVersion: 1,
      recipientName: null,
    }).success).toBe(true);
    expect(contracts.CertificateRecipientNameResponseSchema.safeParse({
      schemaVersion: 1,
      recipientName: {
        version: 1,
        displayName: "Ada Lovelace",
        confirmedAt: "2026-08-15T12:00:00.000Z",
      },
    }).success).toBe(true);
    expect(contracts.CertificateRecipientNameResponseSchema.safeParse({
      schemaVersion: 1,
      recipientName: {
        version: 0,
        displayName: "Ada Lovelace",
        confirmedAt: "2026-08-15T12:00:00.000Z",
      },
    }).success).toBe(false);
    expect(contracts.CertificateRecipientNameResponseSchema.safeParse({
      schemaVersion: 1,
      recipientName: {
        version: 2_147_483_648,
        displayName: "Ada Lovelace",
        confirmedAt: "2026-08-15T12:00:00.000Z",
      },
    }).success).toBe(false);
  });

  it("freezes the exact private certificate status and collection surface", async () => {
    const contracts = await loadCertificateContracts();
    expect(contracts).not.toBeNull();
    if (contracts === null) return;

    expect(contracts.CertificateStatusSchema.options).toEqual([
      "awaiting_recipient_name",
      "pending",
      "failed",
      "issued",
    ]);
    expect(contracts.CertificateListQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(contracts.CertificateListQuerySchema.parse({ limit: "100", cursor: "v1.opaque-token" }))
      .toEqual({ limit: 100, cursor: "v1.opaque-token" });
    for (const limit of ["0", "101", "1e1", "10.0", "0x10", " 10", ["10"]]) {
      expect(contracts.CertificateListQuerySchema.safeParse({ limit }).success).toBe(false);
    }

    const item = {
      id: certificateId,
      courseCompletionId: completionId,
      status: "issued",
      snapshotRenderable: true,
      recipientName: "Zoë 李",
      businessName: "Syntholo Studio",
      courseTitle: "AI Systems Academy",
      courseVersion: 1,
      completedAt: "2026-08-15T12:00:00.000Z",
      issuedAt: "2026-08-15T12:05:00.000Z",
      failureCode: null,
    } as const;
    expect(contracts.CertificateListResponseSchema.safeParse({
      items: [item],
      nextCursor: null,
    }).success).toBe(true);
    expect(contracts.CertificateListItemSchema.safeParse({
      ...item,
      courseVersion: 2_147_483_647,
    }).success).toBe(true);
    expect(contracts.CertificateListItemSchema.safeParse({
      ...item,
      courseVersion: 2_147_483_648,
    }).success).toBe(false);
    expect(contracts.CertificateListItemSchema.safeParse({
      ...item,
      status: "awaiting_recipient_name",
      snapshotRenderable: false,
      recipientName: null,
      businessName: null,
      courseTitle: null,
      issuedAt: null,
      failureCode: null,
    }).success).toBe(true);
    expect(contracts.CertificateListItemSchema.safeParse({
      ...item,
      status: "failed",
      snapshotRenderable: false,
      businessName: null,
      courseTitle: null,
      issuedAt: null,
      failureCode: "snapshot_not_renderable",
    }).success).toBe(true);
    for (const unsafeProjection of [
      {
        ...item,
        status: "failed",
        snapshotRenderable: false,
        issuedAt: null,
        failureCode: "snapshot_not_renderable",
      },
      {
        ...item,
        status: "failed",
        snapshotRenderable: false,
        businessName: null,
        courseTitle: null,
        issuedAt: null,
        failureCode: "render_failed",
      },
      {
        ...item,
        status: "failed",
        snapshotRenderable: true,
        issuedAt: null,
        failureCode: "snapshot_not_renderable",
      },
    ]) expect(contracts.CertificateListItemSchema.safeParse(unsafeProjection).success).toBe(false);
    expect(contracts.CertificateListItemSchema.safeParse({
      ...item,
      courseTitle: "😀".repeat(255),
      businessName: "李".repeat(85),
    }).success).toBe(true);
    for (const snapshotDrift of [
      { courseTitle: "😀".repeat(256) },
      { courseTitle: "Line\nBreak" },
      { courseTitle: "Bidi\u202Eoverride" },
      { courseTitle: "Unsupported \ue000 title" },
      { businessName: "李".repeat(86) },
      { businessName: "Unsupported \ue000 business" },
    ]) {
      expect(contracts.CertificateListItemSchema.safeParse({ ...item, ...snapshotDrift }).success)
        .toBe(false);
    }
    for (const impossible of [
      { ...item, status: "awaiting_recipient_name", recipientName: "Zoë 李", issuedAt: null },
      { ...item, status: "pending", issuedAt: "2026-08-15T12:05:00.000Z" },
      { ...item, status: "failed", issuedAt: null, failureCode: null },
      { ...item, status: "failed", issuedAt: null, failureCode: "consistency_incident" },
      { ...item, status: "issued", issuedAt: null },
    ]) {
      expect(contracts.CertificateListItemSchema.safeParse(impossible).success).toBe(false);
    }
    for (const leaked of [
      { objectKey: `certificates/v1/account/${completionId}.pdf` },
      { providerUrl: "https://blob.example/private.pdf" },
      { certificateNumber: "CERT-1" },
      { verificationUrl: "https://example.test/verify" },
    ]) {
      expect(contracts.CertificateListResponseSchema.safeParse({
        items: [{ ...item, ...leaked }],
        nextCursor: null,
      }).success).toBe(false);
    }
  });

  it("accepts only an honest pending staff delivery request", async () => {
    const contracts = await loadCertificateContracts();
    expect(contracts).not.toBeNull();
    if (contracts === null) return;

    expect(contracts.CreateCertificateDeliveryRequestSchema.parse({
      reason: "Member requested another private delivery link.",
    })).toEqual({ reason: "Member requested another private delivery link." });
    expect(contracts.CertificateDeliveryResponseSchema.parse({
      status: "delivery_pending",
    })).toEqual({ status: "delivery_pending" });
    for (const injected of [
      { destination: "attacker@example.com" },
      { email: "attacker@example.com" },
      { providerMessageId: "provider-1" },
    ]) {
      expect(contracts.CreateCertificateDeliveryRequestSchema.safeParse({
        reason: "Recovery requested.",
        ...injected,
      }).success).toBe(false);
    }
    expect(contracts.CertificateDeliveryResponseSchema.safeParse({
      status: "delivered",
    }).success).toBe(false);
  });
});
