import { memberActor } from "@syntholo/testing";
import { createHash } from "node:crypto";
import { get } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type ApiDependencies } from "../../app.js";

const actor = memberActor({
  actorId: "10000000-0000-4000-8000-000000000001",
  accountId: "10000000-0000-4000-8000-000000000002",
  membershipId: "10000000-0000-4000-8000-000000000003",
  clerkUserId: "clerk_certificate",
  authenticatedAt: new Date("2026-08-15T12:00:00.000Z"),
});
const correlationId = "10000000-0000-4000-8000-000000000004";
const certificateId = "10000000-0000-4000-8000-000000000005";
const completionId = "10000000-0000-4000-8000-000000000006";
const recipientName = {
  schemaVersion: 1,
  recipientName: { version: 1, displayName: "Ada Lovelace", confirmedAt: "2026-08-15T12:00:00.000Z" },
} as const;
const issued = {
  id: certificateId,
  courseCompletionId: completionId,
  status: "issued",
  snapshotRenderable: true,
  recipientName: "Ada Lovelace",
  businessName: "Acme",
  courseTitle: "Academy",
  courseVersion: 1,
  completedAt: "2026-08-15T12:00:00.000Z",
  issuedAt: "2026-08-15T12:01:00.000Z",
  failureCode: null,
} as const;

function dependencies() {
  const certificates = {
    getRecipientName: vi.fn(async () => recipientName),
    confirmRecipientName: vi.fn(async () => recipientName),
    list: vi.fn(async () => ({ items: [issued], nextCursor: null })),
    downloadFence: vi.fn(async () => ({
      certificateId,
      courseCompletionId: completionId,
      accountId: actor.accountId,
      membershipId: actor.membershipId,
      pathname: `certificates/v1/${actor.accountId}/${completionId}.pdf`,
      byteLength: 4,
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      etag: "strong-etag",
      storedAt: "2026-08-15T12:01:00.000Z",
    })),
  };
  const blob = {
    download: vi.fn(async (command: Readonly<{
      pathname: string;
      expected: Readonly<{ byteLength: number; sha256: string; etag: string }>;
      signal: AbortSignal;
    }>) => ({
      pathname: command.pathname,
      byteLength: 4,
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      etag: "strong-etag",
      contentType: "application/pdf" as const,
      bytes: new Uint8Array([1, 2, 3, 4]),
    })),
  };
  const access = { getEffectiveAccess: vi.fn(async () => { throw new Error("must not consult entitlement"); }) };
  const result = {
    releaseSha: "1".repeat(40),
    health: { dependencies: [] },
    auth: { kind: "enabled", dependencies: {
      member: {
        webOrigin: "https://app.syntholo.test",
        audience: "member",
        authorizedParties: ["https://app.syntholo.test"],
        clerk: { authenticateRequest: vi.fn(async () => ({
          userId: actor.clerkUserId,
          firstFactorVerifiedAt: actor.authenticatedAt,
          authorizedParty: "https://app.syntholo.test",
        })) },
        identities: { findMemberActorByClerkUserId: vi.fn(async () => actor) },
        access,
        certificates,
        certificateBlob: blob,
      },
      staff: {
        config: { environment: "test", webOrigin: "https://app.syntholo.test", clientId: "client", organizationId: "org", callbackUrl: "https://app.syntholo.test/v1/staff/auth/callback", defaultReturnTo: "/admin", allowedReturnToPrefixes: ["/admin"], sessionHardTtlSeconds: 3600, loginAttemptTtlSeconds: 300, refreshLeaseSeconds: 5 },
        clock: { now: () => new Date() }, sessionCrypto: {}, loginAttempts: {}, sessions: {}, identities: {}, tokens: {}, access: {}, sleep: async () => undefined,
      },
    } },
  } as unknown as ApiDependencies;
  return { access, blob, certificates, result };
}

describe("member certificate routes", () => {
  it("serves the exact membership-only name, list, and private streamed download flows", async () => {
    const { access, blob, certificates, result } = dependencies();
    const app = await buildApp(result);
    const headers = { authorization: "Bearer member-token", "x-correlation-id": correlationId };
    const name = await app.inject({ method: "GET", url: "/v1/member/certificate-recipient-name", headers });
    expect(name.statusCode, name.payload).toBe(200);
    expect(name.json()).toEqual(recipientName);
    const confirmed = await app.inject({
      method: "PUT",
      url: "/v1/member/certificate-recipient-name",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "certificate-name-intent-0001" },
      payload: { expectedVersion: 0, displayName: " Ada\u00a0Lovelace " },
    });
    expect(confirmed.statusCode, confirmed.payload).toBe(200);
    const list = await app.inject({ method: "GET", url: "/v1/member/certificates?limit=25", headers });
    expect(list.statusCode, list.payload).toBe(200);
    expect(list.json()).toEqual({ items: [issued], nextCursor: null });
    const download = await app.inject({
      method: "GET",
      url: `/v1/member/certificates/${certificateId}/download`,
      headers,
    });
    expect(download.statusCode, download.payload).toBe(200);
    expect(download.rawPayload).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(download.headers).toMatchObject({
      "cache-control": "private, no-store",
      "content-disposition": "attachment; filename=\"syntholo-certificate-of-completion.pdf\"",
      "content-length": "4",
      "content-type": "application/pdf",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      vary: "Authorization",
    });
    expect(access.getEffectiveAccess).not.toHaveBeenCalled();
    expect(certificates.confirmRecipientName).toHaveBeenCalledWith(
      actor,
      correlationId,
      { expectedVersion: 0, displayName: "Ada Lovelace" },
      "certificate-name-intent-0001",
    );
    expect(certificates.list).toHaveBeenCalledWith(actor, correlationId, { limit: 25 });
    expect(blob.download).toHaveBeenCalledWith({
      pathname: `certificates/v1/${actor.accountId}/${completionId}.pdf`,
      expected: {
        byteLength: 4,
        sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
        etag: "strong-etag",
      },
      signal: expect.any(AbortSignal),
    });
    await app.close();
  });

  it("fails closed when the private object tuple differs from the database fence", async () => {
    const { blob, result } = dependencies();
    blob.download.mockResolvedValueOnce({
      pathname: `certificates/v1/${actor.accountId}/${completionId}.pdf`,
      byteLength: 4,
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      etag: "different-etag",
      contentType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    const app = await buildApp(result);
    const response = await app.inject({
      method: "GET",
      url: `/v1/member/certificates/${certificateId}/download`,
      headers: { authorization: "Bearer member-token" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.payload).not.toContain("different-etag");
    await app.close();
  });

  it("aborts the Blob lifecycle and destroys a slow streamed response when the client disconnects", async () => {
    const { blob, certificates, result } = dependencies();
    const bytes = new Uint8Array(2 * 1_024 * 1_024).fill(7);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    certificates.downloadFence.mockResolvedValueOnce({
      certificateId,
      courseCompletionId: completionId,
      accountId: actor.accountId,
      membershipId: actor.membershipId,
      pathname: `certificates/v1/${actor.accountId}/${completionId}.pdf`,
      byteLength: bytes.byteLength,
      sha256,
      etag: "strong-etag",
      storedAt: "2026-08-15T12:01:00.000Z",
    });
    let operationSignal: AbortSignal | undefined;
    blob.download.mockImplementationOnce(async (command) => {
      operationSignal = command.signal;
      return {
        pathname: command.pathname,
        byteLength: bytes.byteLength,
        sha256,
        etag: "strong-etag",
        contentType: "application/pdf" as const,
        bytes,
      };
    });
    const app = await buildApp(result);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      const request = get(`${address}/v1/member/certificates/${certificateId}/download`, {
        headers: { authorization: "Bearer member-token" },
      }, (response) => {
        response.once("data", () => response.destroy());
        response.once("close", resolve);
      });
      request.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
        else reject(error);
      });
    });
    await vi.waitFor(() => expect(operationSignal?.aborted).toBe(true));
    await app.close();
  });

  it("aborts a pending private Blob acquisition when the response socket closes before headers", async () => {
    const { blob, result } = dependencies();
    let acquisitionSignal: AbortSignal | undefined;
    let acquisitionStarted!: () => void;
    const started = new Promise<void>((resolve) => { acquisitionStarted = resolve; });
    blob.download.mockImplementationOnce(async (command) => {
      acquisitionSignal = command.signal;
      acquisitionStarted();
      return new Promise((_, reject) => {
        command.signal.addEventListener("abort", () => reject(new Error("acquisition aborted")), { once: true });
      });
    });
    const app = await buildApp(result);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = get(`${address}/v1/member/certificates/${certificateId}/download`, {
      headers: { authorization: "Bearer member-token" },
    });
    request.on("error", () => undefined);
    await started;
    request.destroy();
    await vi.waitFor(() => expect(acquisitionSignal?.aborted).toBe(true));
    await app.close();
  });

  it("rejects GET bodies, unknown query keys, malformed IDs/cursors, unsafe keys, and every implicit HEAD", async () => {
    const { certificates, result } = dependencies();
    const app = await buildApp(result);
    const headers = { authorization: "Bearer member-token" };
    for (const request of [
      { method: "GET", url: "/v1/member/certificate-recipient-name?extra=1" },
      { method: "GET", url: "/v1/member/certificate-recipient-name", payload: {} },
      { method: "GET", url: "/v1/member/certificates?limit=1e1" },
      { method: "GET", url: "/v1/member/certificates?cursor=forged" },
      { method: "GET", url: "/v1/member/certificates/not-a-uuid/download" },
      { method: "PUT", url: "/v1/member/certificate-recipient-name", headers: { "content-type": "application/json", "idempotency-key": "contains/slash-key" }, payload: { expectedVersion: 0, displayName: "Ada" } },
      { method: "PUT", url: "/v1/member/certificate-recipient-name?extra=1", headers: { "content-type": "application/json", "idempotency-key": "certificate-name-intent-0001" }, payload: { expectedVersion: 0, displayName: "Ada", extra: true } },
    ] as const) {
      const response = await app.inject({ ...request, headers: { ...headers, ...request.headers } });
      expect(response.statusCode, response.payload).toBe(400);
    }
    for (const url of [
      "/v1/member/certificate-recipient-name",
      "/v1/member/certificates",
      `/v1/member/certificates/${certificateId}/download`,
    ]) expect((await app.inject({ method: "HEAD", url, headers })).statusCode).toBe(404);
    expect(certificates.getRecipientName).not.toHaveBeenCalled();
    expect(certificates.confirmRecipientName).not.toHaveBeenCalled();
    expect(certificates.list).not.toHaveBeenCalled();
    expect(certificates.downloadFence).not.toHaveBeenCalled();
    await app.close();
  });
});
