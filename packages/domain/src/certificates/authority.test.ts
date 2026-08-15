import { describe, expect, it } from "vitest";

async function loadCertificateAuthority() {
  return import("./authority.js").catch(() => null);
}

const accountId = "10000000-0000-4000-8000-000000000001";
const membershipId = "10000000-0000-4000-8000-000000000002";
const enrollmentId = "10000000-0000-4000-8000-000000000003";
const courseId = "10000000-0000-4000-8000-000000000004";
const courseVersionId = "10000000-0000-4000-8000-000000000005";
const courseCompletionId = "10000000-0000-4000-8000-000000000006";
const certificatePrerequisiteId = "10000000-0000-4000-8000-000000000007";

const authorityInput = {
  prerequisite: {
    id: certificatePrerequisiteId,
    courseCompletionId,
    accountId,
    membershipId,
    enrollmentId,
    courseId,
    courseVersionId,
  },
  completion: {
    id: courseCompletionId,
    accountId,
    membershipId,
    enrollmentId,
    courseId,
    courseVersionId,
    completedAt: "2026-08-15T12:00:00.000Z",
  },
} as const;

describe("certificate domain authority", () => {
  it("derives one deterministic private object and direct-job identity", async () => {
    const authority = await loadCertificateAuthority();
    expect(authority, "certificate authority module must exist").not.toBeNull();
    if (authority === null) return;

    expect(authority.certificateObjectKey({ accountId, courseCompletionId }))
      .toBe(`certificates/v1/${accountId}/${courseCompletionId}.pdf`);
    expect(authority.certificateJobIdentity(courseCompletionId)).toEqual({
      jobType: "learning.course_completed.certificate.v1",
      idempotencyKey: `certificate:${courseCompletionId}`,
    });
    for (const invalid of ["../escape", "NOT-A-UUID", "", `${accountId}/extra`]) {
      expect(() => authority.certificateObjectKey({ accountId: invalid, courseCompletionId }))
        .toThrow("CERTIFICATE_IDENTITY_INVALID");
    }
  });

  it("accepts only the exact personal prerequisite-to-completion tuple", async () => {
    const authority = await loadCertificateAuthority();
    expect(authority).not.toBeNull();
    if (authority === null) return;

    expect(authority.assertCertificateEligibility(authorityInput)).toEqual({
      accountId,
      membershipId,
      enrollmentId,
      courseId,
      courseVersionId,
      courseCompletionId,
      certificatePrerequisiteId,
      completedAt: "2026-08-15T12:00:00.000Z",
    });
    for (const key of [
      "courseCompletionId",
      "accountId",
      "membershipId",
      "enrollmentId",
      "courseId",
      "courseVersionId",
    ] as const) {
      expect(() => authority.assertCertificateEligibility({
        ...authorityInput,
        prerequisite: { ...authorityInput.prerequisite, [key]: crypto.randomUUID() },
      })).toThrow("CERTIFICATE_ELIGIBILITY_INVALID");
    }
  });

  it("is independent of implementation and commercial state", async () => {
    const authority = await loadCertificateAuthority();
    expect(authority).not.toBeNull();
    if (authority === null) return;

    const refunded = {
      ...authorityInput,
      implementationCompletion: null,
      purchaseStatus: "refunded",
      supportStatus: "expired",
      seatStatus: "revoked",
      circleStatus: "removed",
      businessOsStatus: "degraded",
    };
    const active = {
      ...authorityInput,
      implementationCompletion: { completedAt: "2026-08-15T13:00:00.000Z" },
      purchaseStatus: "paid",
      supportStatus: "active",
      seatStatus: "active",
      circleStatus: "active",
      businessOsStatus: "healthy",
    };
    const first = authority.assertCertificateEligibility(refunded);
    const second = authority.assertCertificateEligibility(active);
    expect(second).toEqual(first);
  });

  it("enforces optimistic names and the closed certificate lifecycle", async () => {
    const authority = await loadCertificateAuthority();
    expect(authority).not.toBeNull();
    if (authority === null) return;

    expect(authority.nextRecipientNameVersion(0, 0)).toBe(1);
    expect(authority.nextRecipientNameVersion(2_147_483_646, 2_147_483_646))
      .toBe(2_147_483_647);
    expect(() => authority.nextRecipientNameVersion(2, 1)).toThrow("VERSION_CONFLICT");
    expect(() => authority.nextRecipientNameVersion(2_147_483_647, 2_147_483_647))
      .toThrow("VERSION_CONFLICT");

    expect(authority.nextCertificateStatus("awaiting_recipient_name", "name_bound"))
      .toBe("pending");
    expect(authority.nextCertificateStatus("awaiting_recipient_name", "name_bound_unrenderable"))
      .toBe("failed");
    expect(authority.nextCertificateStatus("pending", "issued")).toBe("issued");
    expect(authority.nextCertificateStatus("pending", "failed")).toBe("failed");
    expect(authority.nextCertificateStatus("failed", "retry_authorized", "storage_failed"))
      .toBe("pending");
    expect(() => authority.nextCertificateStatus("failed", "retry_authorized", "render_failed"))
      .toThrow("CERTIFICATE_TRANSITION_INVALID");
    expect(() => authority.nextCertificateStatus(
      "failed",
      "retry_authorized",
      "snapshot_not_renderable",
    )).toThrow("CERTIFICATE_TRANSITION_INVALID");
    expect(authority.nextCertificateStatus("issued", "issued")).toBe("issued");
    expect(() => authority.nextCertificateStatus("issued", "failed"))
      .toThrow("CERTIFICATE_TRANSITION_INVALID");
    expect(() => authority.nextCertificateStatus("failed", "name_bound"))
      .toThrow("CERTIFICATE_TRANSITION_INVALID");
    expect(() => authority.nextCertificateStatus("failed", "retry_authorized_unrenderable" as never, "storage_failed"))
      .toThrow("CERTIFICATE_TRANSITION_INVALID");
  });

  it("shares the exact generated font repertoire with browser contracts", async () => {
    const authority = await loadCertificateAuthority();
    expect(authority).not.toBeNull();
    if (authority === null) return;
    expect(authority.CERTIFICATE_FONT_REPERTOIRE_MANIFEST_SHA256)
      .toBe("08b07f94c69e07cf51395aaa8057a4f5c2aebd1571fcf50e32baa89e9c881f96");
    for (const supported of ["ليلى", "आशा", "שירה", "Zoë 李", "𐐀𐐨𐑅"]) {
      expect(authority.canonicalizeCertificateRecipientName(supported)).toBe(supported);
    }
    expect(() => authority.canonicalizeCertificateRecipientName("A\ue000B"))
      .toThrow("CERTIFICATE_RECIPIENT_NAME_INVALID");
    expect(authority.certificateCourseTitleRenderable("😀".repeat(255))).toBe(true);
    expect(authority.certificateBusinessNameRenderable("李".repeat(85))).toBe(true);
    for (const value of ["😀".repeat(256), "Line\nBreak", "Bidi\u202Eoverride", "A\ue000B"]) {
      expect(authority.certificateCourseTitleRenderable(value)).toBe(false);
    }
    expect(authority.certificateBusinessNameRenderable("李".repeat(86))).toBe(false);
  });
});
