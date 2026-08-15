import { z } from "zod";
import type { Database } from "../client.js";
import {
  acquireMemberReadClient,
  DatabaseDependencyUnavailableError,
  destroyMemberReadLease,
  isMemberReadDeadlineError,
  MEMBER_READ_DEADLINES,
  memberReadParentDeadline,
  runMemberReadLockQuery,
  translateMemberReadDependencyError,
  type MemberReadClientLease,
} from "../member-read-deadlines.js";

const UuidSchema = z.string().uuid();
const CertificateObjectKeySchema = z.string().regex(
  /^certificates\/v1\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/u,
);
const CanonicalEtagSchema = z.string()
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,255}$/u)
  .refine((value) => !value.startsWith("W/"));
const FenceSchema = z.object({
  jobId: UuidSchema,
  workerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  attempt: z.number().int().positive().max(2_147_483_647),
  generation: z.number().int().nonnegative().max(2_147_483_647),
  claimToken: UuidSchema,
}).strict();
const TimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+00:00$/u)
  .transform((value, context) => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    context.addIssue({ code: "custom", message: "invalid timestamp" });
    return z.NEVER;
  }
  return parsed.toISOString();
  });
const FailureCodeSchema = z.enum(["snapshot_not_renderable", "render_failed", "storage_failed"]);
const RecordSchema = z.object({
  id: UuidSchema,
  certificate_prerequisite_id: UuidSchema,
  course_completion_id: UuidSchema,
  account_id: UuidSchema,
  membership_id: UuidSchema,
  enrollment_id: UuidSchema,
  course_id: UuidSchema,
  course_version_id: UuidSchema,
  business_name_snapshot: z.string(),
  course_title_snapshot: z.string(),
  course_version: z.number().int().positive().max(2_147_483_647),
  completed_at: TimestampSchema,
  snapshot_renderable: z.boolean(),
  recipient_name_version_id: UuidSchema.nullable(),
  recipient_name_version: z.number().int().positive().max(2_147_483_647).nullable(),
  recipient_name_snapshot: z.string().nullable(),
  renderer_version: z.literal("certificate-pdf.v1"),
  status: z.enum(["pending", "issued", "failed"]),
  failure_code: FailureCodeSchema.nullable(),
  issued_at: TimestampSchema.nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict();
const RecoveryCandidateSchema = RecordSchema.extend({
  recovery_job_id: UuidSchema,
  recovery_attempt: z.number().int().positive().max(5),
  recovery_claim_generation: z.number().int().positive().max(2_147_483_647),
}).strict();
const RecoveryIdentitySchema = z.object({
  certificateId: UuidSchema,
  recoveryJobId: UuidSchema,
  failedAttempt: z.number().int().positive().max(5),
  failedGeneration: z.number().int().positive().max(2_147_483_647),
}).strict();
const RetryCommandSchema = z.discriminatedUnion("objectState", [
  RecoveryIdentitySchema.extend({
    objectState: z.literal("absent"),
    byteLength: z.number().int().positive().max(25 * 1_024 * 1_024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    etag: z.null(),
  }).strict(),
  RecoveryIdentitySchema.extend({
    objectState: z.literal("matching"),
    byteLength: z.number().int().positive().max(25 * 1_024 * 1_024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    etag: CanonicalEtagSchema,
  }).strict(),
]);
const RejectRecoveryCommandSchema = RecoveryIdentitySchema.extend({
  reason: z.enum(["object_mismatch", "provider_shape_invalid", "render_authority_invalid"]),
}).strict();
const FileSchema = z.object({
  id: UuidSchema,
  certificate_id: UuidSchema,
  course_completion_id: UuidSchema,
  account_id: UuidSchema,
  membership_id: UuidSchema,
  object_key: CertificateObjectKeySchema,
  access: z.literal("private"),
  content_type: z.literal("application/pdf"),
  byte_length: z.number().int().positive().max(25 * 1_024 * 1_024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  etag: CanonicalEtagSchema,
  renderer_version: z.literal("certificate-pdf.v1"),
  stored_at: TimestampSchema,
}).strict();

export type CertificateGenerationFence = z.infer<typeof FenceSchema>;
export type CertificateGeneration =
  | Readonly<{
    kind: "pending";
    certificateId: string;
    courseCompletionId: string;
    accountId: string;
    recipientName: string;
    businessName: string;
    courseTitle: string;
    courseVersion: number;
    completedAt: string;
  }>
  | Readonly<{
    kind: "issued";
    certificateId: string;
    courseCompletionId: string;
    accountId: string;
  }>
  | Readonly<{
    kind: "failed";
    certificateId: string;
    courseCompletionId: string;
    accountId: string;
    failureCode: z.infer<typeof FailureCodeSchema>;
  }>;

export type CertificateFile = Readonly<{
  certificateId: string;
  courseCompletionId: string;
  accountId: string;
  membershipId: string;
  objectKey: string;
  byteLength: number;
  sha256: string;
  etag: string;
  storedAt: string;
}>;

export type CertificateStorageRetryCandidate = Readonly<{
  certificateId: string;
  courseCompletionId: string;
  accountId: string;
  recoveryJobId: string;
  failedAttempt: number;
  failedGeneration: number;
  recipientName: string;
  businessName: string;
  courseTitle: string;
  courseVersion: number;
  completedAt: string;
}>;

export class CertificateGenerationInputError extends Error {
  constructor() {
    super("CERTIFICATE_GENERATION_INPUT_INVALID");
    this.name = "CertificateGenerationInputError";
  }
}

export class CertificateGenerationRepositoryError extends Error {
  constructor() {
    super("CERTIFICATE_GENERATION_REPOSITORY_FAILED");
    this.name = "CertificateGenerationRepositoryError";
  }
}

export class CertificateGenerationConsistencyError extends Error {
  constructor() {
    super("CERTIFICATE_GENERATION_CONSISTENCY_INCIDENT");
    this.name = "CertificateGenerationConsistencyError";
  }
}

export class CertificateStorageRecoveryPriorDecisionError extends Error {
  constructor() {
    super("CERTIFICATE_STORAGE_RECOVERY_PRIOR_DECISION");
    this.name = "CertificateStorageRecoveryPriorDecisionError";
  }
}

export class WorkerCertificateRepository {
  constructor(private readonly database: Database) {}

  async loadGenerationFence(
    input: z.input<typeof FenceSchema>,
    signal?: AbortSignal,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<CertificateGeneration> {
    const parsed = FenceSchema.safeParse(input);
    if (!parsed.success) throw new CertificateGenerationInputError();
    const result = await this.queryOne(
      "select to_jsonb(public.syntholo_certificate_load_generation_fence_v1($1,$2,$3,$4,$5)) result",
      [parsed.data.jobId, parsed.data.workerId, parsed.data.attempt, parsed.data.generation, parsed.data.claimToken],
      signal,
      parentDeadline,
    );
    const record = RecordSchema.safeParse(result);
    if (!record.success) throw new CertificateGenerationRepositoryError();
    const row = record.data;
    if (row.status === "pending") {
      if (!row.snapshot_renderable || row.recipient_name_snapshot === null
        || row.failure_code !== null || row.issued_at !== null) {
        throw new CertificateGenerationRepositoryError();
      }
      return Object.freeze({
        kind: "pending",
        certificateId: row.id,
        courseCompletionId: row.course_completion_id,
        accountId: row.account_id,
        recipientName: row.recipient_name_snapshot,
        businessName: row.business_name_snapshot,
        courseTitle: row.course_title_snapshot,
        courseVersion: row.course_version,
        completedAt: row.completed_at,
      });
    }
    if (row.status === "issued") {
      if (row.failure_code !== null || row.issued_at === null) {
        throw new CertificateGenerationRepositoryError();
      }
      return Object.freeze({
        kind: "issued",
        certificateId: row.id,
        courseCompletionId: row.course_completion_id,
        accountId: row.account_id,
      });
    }
    if (row.failure_code === null || row.issued_at !== null) {
      throw new CertificateGenerationRepositoryError();
    }
    return Object.freeze({
      kind: "failed",
      certificateId: row.id,
      courseCompletionId: row.course_completion_id,
      accountId: row.account_id,
      failureCode: row.failure_code,
    });
  }

  async loadIssuedFile(
    input: z.input<typeof FenceSchema>,
    signal?: AbortSignal,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<CertificateFile> {
    return this.fileCommand(
      input,
      "select to_jsonb(public.syntholo_certificate_load_issued_file_v1($1,$2,$3,$4,$5)) result",
      [],
      signal,
      parentDeadline,
    );
  }

  async finalize(
    input: z.input<typeof FenceSchema> & Readonly<{ byteLength: number; sha256: string; etag: string }>,
    signal?: AbortSignal,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<CertificateFile> {
    if (!Number.isInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > 25 * 1_024 * 1_024
      || !/^[0-9a-f]{64}$/u.test(input.sha256)
      || !/^[\x21\x23-\x5b\x5d-\x7e]{1,255}$/u.test(input.etag)) {
      throw new CertificateGenerationInputError();
    }
    return this.fileCommand(
      input,
      "select to_jsonb(public.syntholo_certificate_finalize_v1($1,$2,$3,$4,$5,$6,$7,$8)) result",
      [input.byteLength, input.sha256, input.etag],
      signal,
      parentDeadline,
    );
  }

  async markFailed(
    input: z.input<typeof FenceSchema> & Readonly<{ failureCode: "render_failed" | "storage_failed" }>,
    signal?: AbortSignal,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<Readonly<{ kind: "failed" | "duplicate" }>> {
    const fence = parseFence(input);
    if (!fence.success || !["render_failed", "storage_failed"].includes(input.failureCode)) {
      throw new CertificateGenerationInputError();
    }
    const result = await this.queryOne(
      "select public.syntholo_certificate_mark_failed_v1($1,$2,$3,$4,$5,$6) outcome",
      [fence.data.jobId, fence.data.workerId, fence.data.attempt, fence.data.generation, fence.data.claimToken, input.failureCode],
      signal,
      parentDeadline,
    );
    const outcome = z.enum(["failed", "duplicate"]).safeParse(result);
    if (!outcome.success) throw new CertificateGenerationRepositoryError();
    return Object.freeze({ kind: outcome.data });
  }

  async retry(
    input: Readonly<{
      certificateId: string;
      recoveryJobId: string;
      failedAttempt: number;
      failedGeneration: number;
      objectState: "absent" | "matching";
      byteLength: number;
      sha256: string;
      etag: string | null;
    }>,
    signal?: AbortSignal,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<Readonly<{ kind: "pending" | "duplicate" }>> {
    const parsed = RetryCommandSchema.safeParse(input);
    if (!parsed.success) throw new CertificateGenerationInputError();
    const result = await this.queryOne(
      "select public.syntholo_certificate_retry_v1($1,$2,$3,$4,$5,$6,$7,$8) outcome",
      [parsed.data.certificateId, parsed.data.recoveryJobId, parsed.data.failedAttempt, parsed.data.failedGeneration,
        parsed.data.objectState, parsed.data.byteLength, parsed.data.sha256, parsed.data.etag],
      signal,
      parentDeadline,
    );
    if (result === "prior_decision") throw new CertificateStorageRecoveryPriorDecisionError();
    const outcome = z.enum(["pending", "duplicate"]).safeParse(result);
    if (!outcome.success) throw new CertificateGenerationRepositoryError();
    return Object.freeze({ kind: outcome.data });
  }

  async listStorageRetryCandidates(
    limit: number,
    signal?: AbortSignal,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<readonly CertificateStorageRetryCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CertificateGenerationInputError();
    }
    const result = await this.queryOne(
      "select public.syntholo_certificate_storage_retry_candidates_v1($1) result",
      [limit],
      signal,
      parentDeadline,
    );
    const candidates = z.array(RecoveryCandidateSchema).safeParse(result);
    if (!candidates.success) throw new CertificateGenerationRepositoryError();
    return Object.freeze(candidates.data.map((row) => {
      if (row.status !== "failed" || row.failure_code !== "storage_failed"
        || !row.snapshot_renderable || row.recipient_name_snapshot === null || row.issued_at !== null) {
        throw new CertificateGenerationRepositoryError();
      }
      return Object.freeze({
        certificateId: row.id,
        courseCompletionId: row.course_completion_id,
        accountId: row.account_id,
        recoveryJobId: row.recovery_job_id,
        failedAttempt: row.recovery_attempt,
        failedGeneration: row.recovery_claim_generation,
        recipientName: row.recipient_name_snapshot,
        businessName: row.business_name_snapshot,
        courseTitle: row.course_title_snapshot,
        courseVersion: row.course_version,
        completedAt: row.completed_at,
      });
    }));
  }

  async rejectStorageRecovery(
    input: Readonly<{
      certificateId: string;
      recoveryJobId: string;
      failedAttempt: number;
      failedGeneration: number;
      reason: "object_mismatch" | "provider_shape_invalid" | "render_authority_invalid";
    }>,
    signal?: AbortSignal,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<Readonly<{ kind: "rejected" | "duplicate" }>> {
    const parsed = RejectRecoveryCommandSchema.safeParse(input);
    if (!parsed.success) throw new CertificateGenerationInputError();
    const result = await this.queryOne(
      "select public.syntholo_certificate_recovery_reject_v1($1,$2,$3,$4,$5) outcome",
      [parsed.data.certificateId, parsed.data.recoveryJobId, parsed.data.failedAttempt,
        parsed.data.failedGeneration, parsed.data.reason],
      signal,
      parentDeadline,
    );
    if (result === "prior_decision") throw new CertificateStorageRecoveryPriorDecisionError();
    const outcome = z.enum(["rejected", "duplicate"]).safeParse(result);
    if (!outcome.success) throw new CertificateGenerationRepositoryError();
    return Object.freeze({ kind: outcome.data });
  }

  async promote(
    limit: number,
    signal?: AbortSignal,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<Readonly<{ promoted: number }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CertificateGenerationInputError();
    }
    const result = await this.queryOne(
      "select public.syntholo_certificate_promote_v1($1) outcome",
      [limit],
      signal,
      parentDeadline,
    );
    const promoted = z.number().int().nonnegative().max(limit).safeParse(result);
    if (!promoted.success) throw new CertificateGenerationRepositoryError();
    return Object.freeze({ promoted: promoted.data });
  }

  private async fileCommand(
    input: z.input<typeof FenceSchema>,
    queryText: string,
    tail: readonly unknown[],
    signal: AbortSignal | undefined,
    parentDeadline: number,
  ): Promise<CertificateFile> {
    const parsed = parseFence(input);
    if (!parsed.success) throw new CertificateGenerationInputError();
    const result = await this.queryOne(
      queryText,
      [parsed.data.jobId, parsed.data.workerId, parsed.data.attempt, parsed.data.generation, parsed.data.claimToken, ...tail],
      signal,
      parentDeadline,
    );
    const file = FileSchema.safeParse(result);
    if (!file.success) throw new CertificateGenerationRepositoryError();
    if (file.data.object_key !== `certificates/v1/${file.data.account_id}/${file.data.course_completion_id}.pdf`) {
      throw new CertificateGenerationRepositoryError();
    }
    return Object.freeze({
      certificateId: file.data.certificate_id,
      courseCompletionId: file.data.course_completion_id,
      accountId: file.data.account_id,
      membershipId: file.data.membership_id,
      objectKey: file.data.object_key,
      byteLength: file.data.byte_length,
      sha256: file.data.sha256,
      etag: file.data.etag,
      storedAt: file.data.stored_at,
    });
  }

  private async queryOne(
    text: string,
    values: readonly unknown[],
    signal: AbortSignal | undefined,
    parentDeadline: number,
  ): Promise<unknown> {
    let lease: MemberReadClientLease | undefined;
    try {
      if (signal?.aborted === true) throw new DatabaseDependencyUnavailableError("parent_timeout");
      const acquisition = acquireMemberReadClient(
        this.database.pool,
        performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs,
        parentDeadline,
      );
      const acquired = signal === undefined
        ? { kind: "value" as const, value: await acquisition }
        : await raceAbort(acquisition, signal);
      if (acquired.kind === "aborted") {
        void acquisition.then(
          (lateLease) => destroyMemberReadLease(lateLease).catch(() => undefined),
          () => undefined,
        );
        throw new DatabaseDependencyUnavailableError("parent_timeout");
      }
      lease = acquired.value;
      const query = runMemberReadLockQuery<{ result?: unknown; outcome?: unknown }>(
        lease,
        performance.now() + MEMBER_READ_DEADLINES.lockMs,
        parentDeadline,
        text,
        [...values],
      );
      const queried = signal === undefined
        ? { kind: "value" as const, value: await query }
        : await raceAbort(query, signal);
      if (queried.kind === "aborted") {
        void query.catch(() => undefined);
        await destroyMemberReadLease(lease);
        throw new DatabaseDependencyUnavailableError("parent_timeout");
      }
      const row = queried.value.rows[0];
      if (row === undefined) throw new CertificateGenerationRepositoryError();
      return "result" in row ? row.result : row.outcome;
    } catch (error) {
      if (error instanceof CertificateGenerationInputError
        || error instanceof CertificateGenerationConsistencyError
        || error instanceof CertificateGenerationRepositoryError
        || error instanceof DatabaseDependencyUnavailableError) throw error;
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      if (error instanceof Error && [
        "CERTIFICATE_JOB_FENCE_INVALID",
        "CERTIFICATE_RETRY_INPUT_INVALID",
      ].includes(error.message)) {
        throw new CertificateGenerationInputError();
      }
      if (error instanceof Error && [
        "CERTIFICATE_JOB_ACK_MISMATCH",
        "CERTIFICATE_RETRY_RECONCILIATION_REQUIRED",
      ].includes(error.message)) throw new CertificateGenerationConsistencyError();
      throw new CertificateGenerationRepositoryError();
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }
}

function parseFence(input: z.input<typeof FenceSchema>): ReturnType<typeof FenceSchema.safeParse> {
  return FenceSchema.safeParse({
    jobId: input.jobId,
    workerId: input.workerId,
    attempt: input.attempt,
    generation: input.generation,
    claimToken: input.claimToken,
  });
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<
  Readonly<{ kind: "value"; value: T }> | Readonly<{ kind: "aborted" }>
> {
  if (signal.aborted) return Promise.resolve({ kind: "aborted" });
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => { if (!settled) { settled = true; resolve({ kind: "aborted" }); } };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve({ kind: "value", value });
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}
