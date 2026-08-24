import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

async function loadRepository() {
  return import("./certificates.js").catch(() => null);
}

const actor = {
  kind: "member",
  actorId: "10000000-0000-4000-8000-000000000001",
  clerkUserId: "user_certificate",
  accountId: "10000000-0000-4000-8000-000000000002",
  membershipId: "10000000-0000-4000-8000-000000000003",
  role: "owner",
  authenticatedAt: new Date("2026-08-15T12:00:00.000Z"),
} as const;
const staff = {
  kind: "staff",
  actorId: "10000000-0000-4000-8000-000000000004",
  accessUserId: "removed_certificate",
  staffId: "10000000-0000-4000-8000-000000000004",
  role: "admin",
  permissions: ["certificates:deliver"],
  authenticatedAt: new Date("2026-08-15T12:00:00.000Z"),
} as const;
const correlationId = "10000000-0000-4000-8000-000000000005";
const certificateId = "10000000-0000-4000-8000-000000000006";
const completionId = "10000000-0000-4000-8000-000000000007";

function database(resultFor: (text: string) => readonly Record<string, unknown>[]) {
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => ({
    rows: resultFor(text),
    values,
  }));
  const release = vi.fn();
  return { database: { pool: { connect: async () => ({ query, release }) } } as never, query, release };
}

describe("certificate repositories", () => {
  it("confirms the canonical membership-scoped name with one exact receipt hash", async () => {
    const module = await loadRepository();
    expect(module, "certificate repository must exist").not.toBeNull();
    if (module === null) return;
    const response = {
      schemaVersion: 1,
      recipientName: { version: 1, displayName: "Ada Lovelace", confirmedAt: "2026-08-15T12:00:00.000Z" },
    } as const;
    const fixture = database((text) => text.includes("syntholo_certificate_confirm_recipient_name_v1")
      ? [{ result: response }]
      : []);
    const repository = new module.MemberCertificatesRepository(
      fixture.database,
      "certificate-cursor-secret-at-least-32-bytes",
    );
    await expect(repository.confirmRecipientName(
      actor,
      correlationId,
      { expectedVersion: 0, displayName: " Ada\u00a0Lovelace " },
      "certificate-name-intent-0001",
    )).resolves.toEqual(response);
    const command = fixture.query.mock.calls.find(([text]) =>
      String(text).includes("syntholo_certificate_confirm_recipient_name_v1"));
    expect(command?.[1]?.slice(0, 3)).toEqual([0, "Ada Lovelace", "certificate-name-intent-0001"]);
    expect(command?.[1]?.[3]).toBe(createHash("sha256").update(JSON.stringify({
      accountId: actor.accountId,
      displayName: "Ada Lovelace",
      expectedVersion: 0,
      membershipId: actor.membershipId,
      routeVersion: "certificate-recipient-name.v1",
    })).digest("hex"));
  });

  it("authenticates list cursors to actor/account/membership/route/limit and redacts unsafe snapshots", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const items = [
      {
        id: certificateId, courseCompletionId: completionId, status: "issued",
        snapshotRenderable: true, recipientName: "Ada Lovelace", businessName: "Acme",
        courseTitle: "Academy", courseVersion: 1, completedAt: "2026-08-15T12:00:00.000Z",
        issuedAt: "2026-08-15T12:01:00.000Z", failureCode: null,
      },
      {
        id: "10000000-0000-4000-8000-000000000008",
        courseCompletionId: "10000000-0000-4000-8000-000000000009",
        status: "failed", snapshotRenderable: false, recipientName: "Ada Lovelace",
        businessName: null, courseTitle: null, courseVersion: 1,
        completedAt: "2026-08-14T12:00:00.000Z", issuedAt: null,
        failureCode: "snapshot_not_renderable",
      },
    ] as const;
    const fixture = database((text) => text.includes("syntholo_certificates_list_v1")
      ? [{ result: items }]
      : []);
    const secret = "certificate-cursor-secret-at-least-32-bytes";
    const repository = new module.MemberCertificatesRepository(fixture.database, secret);
    const first = await repository.list(actor, correlationId, { limit: 1 });
    expect(first.items).toEqual([items[0]]);
    expect(first.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);
    expect(module.decodeCertificateCursor(first.nextCursor!, {
      accountId: actor.accountId,
      actorId: actor.actorId,
      membershipId: actor.membershipId,
      limit: 1,
    }, secret)).toEqual({ completedAt: items[0].completedAt, id: items[0].id });
    expect(() => module.decodeCertificateCursor(first.nextCursor!, {
      accountId: actor.accountId,
      actorId: actor.actorId,
      membershipId: actor.membershipId,
      limit: 2,
    }, secret)).toThrow("CERTIFICATE_CURSOR_INVALID");
    expect(JSON.stringify(first)).not.toContain("PRIVATE_UNSAFE_SNAPSHOT");
  });

  it("returns only the exact immutable private-file fence and creates one staff delivery receipt", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const file = {
      id: "10000000-0000-4000-8000-000000000010",
      certificate_id: certificateId,
      course_completion_id: completionId,
      account_id: actor.accountId,
      membership_id: actor.membershipId,
      object_key: `certificates/v1/${actor.accountId}/${completionId}.pdf`,
      access: "private",
      content_type: "application/pdf",
      byte_length: 4096,
      sha256: "a".repeat(64),
      etag: "strong-etag",
      renderer_version: "certificate-pdf.v1",
      stored_at: "2026-08-15T12:01:00.000+00:00",
    };
    const fixture = database((text) => {
      if (text.includes("syntholo_certificate_download_fence_v1")) return [file];
      if (text.includes("syntholo_certificate_create_delivery_v1")) {
        return [{ result: { status: "delivery_pending" } }];
      }
      return [];
    });
    const member = new module.MemberCertificatesRepository(
      fixture.database,
      "certificate-cursor-secret-at-least-32-bytes",
    );
    await expect(member.downloadFence(actor, correlationId, certificateId)).resolves.toEqual({
      certificateId,
      courseCompletionId: completionId,
      accountId: actor.accountId,
      membershipId: actor.membershipId,
      pathname: file.object_key,
      byteLength: 4096,
      sha256: file.sha256,
      etag: file.etag,
      storedAt: "2026-08-15T12:01:00.000Z",
    });
    const staffRepository = new module.StaffCertificatesRepository(fixture.database);
    await expect(staffRepository.createDelivery(
      staff,
      correlationId,
      certificateId,
      { reason: "Customer requested recovery" },
      "certificate-delivery-intent-0001",
    )).resolves.toEqual({ status: "delivery_pending" });
    const delivery = fixture.query.mock.calls.find(([text]) =>
      String(text).includes("syntholo_certificate_create_delivery_v1"));
    expect(delivery?.[1]?.slice(0, 3)).toEqual([
      certificateId, "Customer requested recovery", "certificate-delivery-intent-0001",
    ]);
    expect(delivery?.[1]?.[3]).toBe(createHash("sha256").update(JSON.stringify({
      certificateId,
      reason: "Customer requested recovery",
      routeVersion: "certificate-delivery.v1",
    })).digest("hex"));
  });

  it("maps only safe closed SQL outcomes and redacts malformed/private database failures", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    for (const code of [
      "CERTIFICATE_NOT_FOUND", "VERSION_CONFLICT", "IDEMPOTENCY_KEY_REUSED",
      "IDEMPOTENCY_IN_PROGRESS", "CERTIFICATE_COMMAND_INVALID",
    ] as const) {
      const fixture = database((text) => {
        if (text === "begin" || text.startsWith("select set_config") || text === "rollback") return [];
        throw new Error(code);
      });
      const repository = new module.MemberCertificatesRepository(
        fixture.database,
        "certificate-cursor-secret-at-least-32-bytes",
      );
      await expect(repository.getRecipientName(actor, correlationId)).rejects.toMatchObject({ code });
    }
    const marker = "PRIVATE_CERTIFICATE_SNAPSHOT";
    const fixture = database((text) => {
      if (text === "begin" || text.startsWith("select set_config") || text === "rollback") return [];
      throw Object.assign(new Error("database failed"), { detail: marker });
    });
    const repository = new module.MemberCertificatesRepository(
      fixture.database,
      "certificate-cursor-secret-at-least-32-bytes",
    );
    let failure: unknown;
    try {
      await repository.getRecipientName(actor, correlationId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "CERTIFICATE_DEPENDENCY_FAILED" });
    expect(JSON.stringify(failure)).not.toContain(marker);
  });
});
