import {
  CertificateDeliveryResponseSchema,
  CertificateListItemSchema,
  CertificateListResponseSchema,
  CertificateRecipientNameResponseSchema,
  canonicalizeCertificateRecipientNameInput,
  type CertificateDeliveryResponse,
  type CertificateListResponse,
  type CertificateRecipientNameResponse,
  type ConfirmCertificateRecipientNameRequest,
  type CreateCertificateDeliveryRequest,
} from "@syntholo/contracts/learning";
import type { MemberActor, StaffActor } from "@syntholo/domain";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Database } from "../client.js";
import {
  acquireMemberReadClient,
  DatabaseDependencyUnavailableError,
  destroyMemberReadLease,
  isMemberReadDeadlineError,
  MEMBER_READ_DEADLINES,
  memberReadParentDeadline,
  runMemberReadCleanupQuery,
  runMemberReadLockQuery,
  runMemberReadQuery,
  throwIfMemberReadDeadlineExpired,
  translateMemberReadDependencyError,
} from "../member-read-deadlines.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const idempotencyKey = /^[A-Za-z0-9._~-]{16,128}$/u;
const strictPgTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/u;
const canonicalEtag = /^[\x21\x23-\x5b\x5d-\x7e]{1,255}$/u;

const CursorPayloadSchema = z.object({
  v: z.literal(1), r: z.literal("certificate-list"),
  a: z.string().uuid(), u: z.string().uuid(), m: z.string().uuid(),
  l: z.number().int().min(1).max(100),
  t: z.string().datetime({ offset: false, precision: 3 }), i: z.string().uuid(),
}).strict();
const CursorEnvelopeSchema = z.object({
  p: CursorPayloadSchema,
  s: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

type CertificateCursorBinding = Readonly<{
  accountId: string; actorId: string; membershipId: string; limit: number;
}>;
type CertificateCursorValue = Readonly<{ completedAt: string; id: string }>;

function signingSecret(secret: string): Buffer {
  const value = Buffer.from(secret, "utf8");
  if (value.byteLength < 32) throw new Error("CERTIFICATE_CURSOR_SECRET_INVALID");
  return value;
}

function encodeCertificateCursor(
  value: CertificateCursorValue,
  binding: CertificateCursorBinding,
  secret: string,
): string {
  const payload = CursorPayloadSchema.parse({
    v: 1, r: "certificate-list", a: binding.accountId, u: binding.actorId,
    m: binding.membershipId, l: binding.limit, t: value.completedAt, i: value.id,
  });
  const envelope = {
    p: payload,
    s: createHmac("sha256", signingSecret(secret)).update(JSON.stringify(payload), "utf8").digest("hex"),
  };
  return `v1.${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
}

export function decodeCertificateCursor(
  cursor: string,
  binding: CertificateCursorBinding,
  secret: string,
): CertificateCursorValue {
  try {
    if (!cursor.startsWith("v1.")) throw new Error();
    const encoded = cursor.slice(3);
    if (encoded.length < 1 || encoded.length > 512) throw new Error();
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) throw new Error();
    const envelope = CursorEnvelopeSchema.parse(JSON.parse(decoded));
    const expected = createHmac("sha256", signingSecret(secret))
      .update(JSON.stringify(envelope.p), "utf8").digest();
    const received = Buffer.from(envelope.s, "hex");
    if (!timingSafeEqual(expected, received)
      || envelope.p.a !== binding.accountId || envelope.p.u !== binding.actorId
      || envelope.p.m !== binding.membershipId || envelope.p.l !== binding.limit) throw new Error();
    return Object.freeze({ completedAt: envelope.p.t, id: envelope.p.i });
  } catch {
    throw new CertificateRepositoryError("INVALID_CURSOR");
  }
}

export type CertificateRepositoryErrorCode =
  | "CERTIFICATE_NOT_FOUND" | "VERSION_CONFLICT" | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_IN_PROGRESS" | "CERTIFICATE_COMMAND_INVALID" | "INVALID_CURSOR"
  | "CERTIFICATE_DEPENDENCY_FAILED";

export class CertificateRepositoryError extends Error {
  constructor(readonly code: CertificateRepositoryErrorCode) {
    super(code === "INVALID_CURSOR" ? "CERTIFICATE_CURSOR_INVALID" : code);
    this.name = "CertificateRepositoryError";
  }
}

function mappedError(error: unknown): CertificateRepositoryError | null {
  const message = error instanceof Error ? error.message : "";
  const code = [
    "CERTIFICATE_NOT_FOUND", "VERSION_CONFLICT", "IDEMPOTENCY_KEY_REUSED",
    "IDEMPOTENCY_IN_PROGRESS", "CERTIFICATE_COMMAND_INVALID",
  ].find((candidate) => message === candidate);
  return code === undefined ? null : new CertificateRepositoryError(code as CertificateRepositoryErrorCode);
}

function requestHash(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function normalizeTimestamp(value: string): string {
  if (!strictPgTimestamp.test(value)) throw new Error("CERTIFICATE_RESULT_INVALID");
  const normalized = new Date(value).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalized)) {
    throw new Error("CERTIFICATE_RESULT_INVALID");
  }
  return normalized;
}

const FileRowSchema = z.object({
  id: z.string().uuid(), certificate_id: z.string().uuid(), course_completion_id: z.string().uuid(),
  account_id: z.string().uuid(), membership_id: z.string().uuid(),
  object_key: z.string(), access: z.literal("private"), content_type: z.literal("application/pdf"),
  byte_length: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  etag: z.string().regex(canonicalEtag), renderer_version: z.literal("certificate-pdf.v1"),
  stored_at: z.string().regex(strictPgTimestamp),
}).strict();

export type CertificateDownloadFence = Readonly<{
  certificateId: string; courseCompletionId: string; accountId: string; membershipId: string;
  pathname: string; byteLength: number; sha256: string; etag: string; storedAt: string;
}>;

async function transaction<T>(
  database: Database,
  actor: MemberActor | StaffActor,
  correlationId: string,
  parentDeadline: number,
  run: (query: <R extends Record<string, unknown>>(
    text: string, values?: readonly unknown[], lock?: boolean,
  ) => Promise<readonly R[]>) => Promise<T>,
): Promise<T> {
  if (!uuid.test(actor.actorId) || !uuid.test(correlationId)
    || (actor.kind === "member" && (!uuid.test(actor.accountId) || !uuid.test(actor.membershipId)))) {
    throw new Error("CERTIFICATE_ACTOR_INVALID");
  }
  let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
  let open = false;
  try {
    lease = await acquireMemberReadClient(
      database.pool, performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs, parentDeadline,
    );
    const query = async <R extends Record<string, unknown>>(
      text: string, values: readonly unknown[] = [], lock = false,
    ) => (await (lock ? runMemberReadLockQuery : runMemberReadQuery)<R>(
      lease!, performance.now() + (lock ? MEMBER_READ_DEADLINES.lockMs : MEMBER_READ_DEADLINES.queryMs),
      parentDeadline, text, values,
    )).rows;
    await query("begin");
    open = true;
    if (actor.kind === "member") {
      await query(
        "select set_config('app.account_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.membership_id',$3,true),set_config('app.actor_kind','member',true),set_config('app.correlation_id',$4,true),set_config('app.actor_role',$5,true),set_config('app.authenticated_at',$6,true)",
        [actor.accountId, actor.actorId, actor.membershipId, correlationId, actor.role, actor.authenticatedAt.toISOString()],
      );
    } else {
      await query(
        "select set_config('app.actor_id',$1,true),set_config('app.actor_kind','staff',true),set_config('app.correlation_id',$2,true),set_config('app.authenticated_at',$3,true)",
        [actor.actorId, correlationId, actor.authenticatedAt.toISOString()],
      );
    }
    const result = await run(query);
    await throwIfMemberReadDeadlineExpired(lease, parentDeadline);
    await query("commit");
    open = false;
    return result;
  } catch (error) {
    if (open && lease !== undefined && !lease.destroyed) {
      const acquired = lease;
      await runMemberReadCleanupQuery(acquired, MEMBER_READ_DEADLINES.cleanupMs, "rollback")
        .catch(async () => destroyMemberReadLease(acquired));
    }
    if (error instanceof CertificateRepositoryError || error instanceof DatabaseDependencyUnavailableError) throw error;
    if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
    const mapped = mappedError(error);
    if (mapped !== null) throw mapped;
    throw new CertificateRepositoryError("CERTIFICATE_DEPENDENCY_FAILED");
  } finally {
    if (lease !== undefined && !lease.destroyed) lease.release();
  }
}

export class MemberCertificatesRepository {
  constructor(private readonly database: Database, private readonly cursorSecret: string) {
    signingSecret(cursorSecret);
  }

  async getRecipientName(
    actor: MemberActor, correlationId: string, parentDeadline = memberReadParentDeadline(),
  ): Promise<CertificateRecipientNameResponse> {
    return transaction(this.database, actor, correlationId, parentDeadline, async (query) => {
      const rows = await query<{ result: unknown }>(
        "select public.syntholo_certificate_recipient_name_get_v1() result",
      );
      return CertificateRecipientNameResponseSchema.parse(rows[0]?.result);
    });
  }

  async confirmRecipientName(
    actor: MemberActor,
    correlationId: string,
    input: ConfirmCertificateRecipientNameRequest,
    key: string,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<CertificateRecipientNameResponse> {
    const displayName = canonicalizeCertificateRecipientNameInput(input.displayName);
    if (!idempotencyKey.test(key)) throw new CertificateRepositoryError("CERTIFICATE_COMMAND_INVALID");
    const hash = requestHash({
      accountId: actor.accountId, displayName, expectedVersion: input.expectedVersion,
      membershipId: actor.membershipId, routeVersion: "certificate-recipient-name.v1",
    });
    return transaction(this.database, actor, correlationId, parentDeadline, async (query) => {
      const rows = await query<{ result: unknown }>(
        "select public.syntholo_certificate_confirm_recipient_name_v1($1,$2,$3,$4) result",
        [input.expectedVersion, displayName, key, hash], true,
      );
      return CertificateRecipientNameResponseSchema.parse(rows[0]?.result);
    });
  }

  async list(
    actor: MemberActor,
    correlationId: string,
    input: Readonly<{ limit: number; cursor?: string }>,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<CertificateListResponse> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new CertificateRepositoryError("INVALID_CURSOR");
    }
    const binding = {
      accountId: actor.accountId, actorId: actor.actorId,
      membershipId: actor.membershipId, limit: input.limit,
    };
    const before = input.cursor === undefined
      ? null
      : decodeCertificateCursor(input.cursor, binding, this.cursorSecret);
    return transaction(this.database, actor, correlationId, parentDeadline, async (query) => {
      const rows = await query<{ result: unknown }>(
        "select public.syntholo_certificates_list_v1($1,$2,$3) result",
        [before?.completedAt ?? null, before?.id ?? null, input.limit + 1],
      );
      if (!Array.isArray(rows[0]?.result) || rows[0].result.length > 101) {
        throw new Error("CERTIFICATE_RESULT_INVALID");
      }
      const parsed = rows[0].result.map((item) => CertificateListItemSchema.parse(item));
      const items = parsed.slice(0, input.limit);
      const nextCursor = parsed.length > input.limit && items.length > 0
        ? encodeCertificateCursor({ completedAt: items.at(-1)!.completedAt, id: items.at(-1)!.id }, binding, this.cursorSecret)
        : null;
      return CertificateListResponseSchema.parse({ items, nextCursor });
    });
  }

  async downloadFence(
    actor: MemberActor,
    correlationId: string,
    certificateId: string,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<CertificateDownloadFence> {
    if (!uuid.test(certificateId)) throw new CertificateRepositoryError("CERTIFICATE_COMMAND_INVALID");
    return transaction(this.database, actor, correlationId, parentDeadline, async (query) => {
      const rows = await query<Record<string, unknown>>(
        "select * from public.syntholo_certificate_download_fence_v1($1)", [certificateId],
      );
      const file = FileRowSchema.parse(rows[0]);
      const expectedPath = `certificates/v1/${actor.accountId}/${file.course_completion_id}.pdf`;
      if (file.certificate_id !== certificateId || file.account_id !== actor.accountId
        || file.membership_id !== actor.membershipId || file.object_key !== expectedPath) {
        throw new Error("CERTIFICATE_RESULT_INVALID");
      }
      return Object.freeze({
        certificateId: file.certificate_id, courseCompletionId: file.course_completion_id,
        accountId: file.account_id, membershipId: file.membership_id, pathname: file.object_key,
        byteLength: file.byte_length, sha256: file.sha256, etag: file.etag,
        storedAt: normalizeTimestamp(file.stored_at),
      });
    });
  }
}

export class StaffCertificatesRepository {
  constructor(private readonly database: Database) {}

  async createDelivery(
    actor: StaffActor,
    correlationId: string,
    certificateId: string,
    input: CreateCertificateDeliveryRequest,
    key: string,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<CertificateDeliveryResponse> {
    if (!uuid.test(certificateId) || !idempotencyKey.test(key)) {
      throw new CertificateRepositoryError("CERTIFICATE_COMMAND_INVALID");
    }
    const hash = requestHash({
      certificateId, reason: input.reason, routeVersion: "certificate-delivery.v1",
    });
    return transaction(this.database, actor, correlationId, parentDeadline, async (query) => {
      const rows = await query<{ result: unknown }>(
        "select public.syntholo_certificate_create_delivery_v1($1,$2,$3,$4) result",
        [certificateId, input.reason, key, hash], true,
      );
      return CertificateDeliveryResponseSchema.parse(rows[0]?.result);
    });
  }
}
