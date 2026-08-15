import {
  ArtifactDetailResponseSchema,
  ArtifactListResponseSchema,
  ArtifactVersionsResponseSchema,
  SaveArtifactVersionRequestSchema,
  SaveArtifactVersionResponseSchema,
  type ArtifactDetailResponse,
  type ArtifactListResponse,
  type ArtifactVersionsResponse,
  type SaveArtifactVersionRequest,
  type SaveArtifactVersionResponse,
} from "@syntholo/contracts/implementation";
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalizeArtifactContent } from "@syntholo/domain/implementation";
import type { MemberActor } from "@syntholo/domain";
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
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const CursorPayloadSchema = z.object({
  v: z.literal(1),
  r: z.literal("artifact-history"),
  a: z.string().uuid(),
  u: z.string().uuid(),
  m: z.string().uuid(),
  x: z.string().uuid(),
  l: z.number().int().min(1).max(100),
  t: z.string().datetime({ offset: false, precision: 3 }),
  i: z.string().uuid(),
}).strict();
const CursorEnvelopeSchema = z.object({
  p: CursorPayloadSchema,
  s: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
type CursorValue = Readonly<{ createdAt: string; id: string }>;
type CursorBinding = Readonly<{
  accountId: string;
  actorId: string;
  membershipId: string;
  artifactId: string;
  limit: number;
}>;

function cursorSecret(secret: string): Buffer {
  const bytes = Buffer.from(secret, "utf8");
  if (bytes.byteLength < 32) throw new Error("IMPLEMENTATION_CURSOR_SECRET_INVALID");
  return bytes;
}

export function encodeImplementationHistoryCursor(
  value: CursorValue,
  binding: CursorBinding,
  secret: string,
): string {
  const payload = CursorPayloadSchema.parse({
    v: 1,
    r: "artifact-history",
    a: binding.accountId,
    u: binding.actorId,
    m: binding.membershipId,
    x: binding.artifactId,
    l: binding.limit,
    t: value.createdAt,
    i: value.id,
  });
  const serializedPayload = JSON.stringify(payload);
  const envelope = {
    p: payload,
    s: createHmac("sha256", cursorSecret(secret)).update(serializedPayload, "utf8").digest("hex"),
  };
  return `v1.${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
}

export function decodeImplementationHistoryCursor(
  cursor: string,
  binding: CursorBinding,
  secret: string,
): CursorValue {
  const signingSecret = cursorSecret(secret);
  try {
    if (!cursor.startsWith("v1.")) throw new Error();
    const encoded = cursor.slice(3);
    if (encoded.length < 1 || encoded.length > 512) throw new Error();
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) throw new Error();
    const envelope = CursorEnvelopeSchema.parse(JSON.parse(decoded));
    const expected = createHmac("sha256", signingSecret)
      .update(JSON.stringify(envelope.p), "utf8").digest();
    const received = Buffer.from(envelope.s, "hex");
    if (!timingSafeEqual(expected, received)) throw new Error();
    if (
      envelope.p.a !== binding.accountId
      || envelope.p.u !== binding.actorId
      || envelope.p.m !== binding.membershipId
      || envelope.p.x !== binding.artifactId
      || envelope.p.l !== binding.limit
    ) throw new Error();
    return Object.freeze({ createdAt: envelope.p.t, id: envelope.p.i });
  } catch {
    throw new ImplementationRepositoryError("INVALID_CURSOR");
  }
}

export class ImplementationRepositoryError extends Error {
  constructor(readonly code: "IMPLEMENTATION_NOT_FOUND" | "VERSION_CONFLICT" | "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_IN_PROGRESS" | "INVALID_CURSOR" | "IMPLEMENTATION_COMMAND_INVALID" | "IMPLEMENTATION_DEPENDENCY_FAILED") {
    super(code === "INVALID_CURSOR" ? "IMPLEMENTATION_CURSOR_INVALID" : code);
    this.name = "ImplementationRepositoryError";
  }
}

function validateActor(actor: MemberActor): void {
  if (actor.kind !== "member" || !uuid.test(actor.actorId) || !uuid.test(actor.accountId) || !uuid.test(actor.membershipId)) {
    throw new Error("IMPLEMENTATION_ACTOR_INVALID");
  }
}

function safeError(error: unknown): ImplementationRepositoryError | null {
  const message = error instanceof Error ? error.message : "";
  const code = [
    "IMPLEMENTATION_NOT_FOUND", "VERSION_CONFLICT", "IDEMPOTENCY_KEY_REUSED",
    "IDEMPOTENCY_IN_PROGRESS", "IMPLEMENTATION_COMMAND_INVALID",
  ].find((candidate) => message === candidate);
  return code === undefined ? null : new ImplementationRepositoryError(code as ConstructorParameters<typeof ImplementationRepositoryError>[0]);
}

const InternalHistorySchema = z.object({
  items: z.array(z.unknown()),
  hasMore: z.boolean(),
  nextCreatedAt: z.string().datetime({ offset: false, precision: 3 }).nullable(),
  nextId: z.string().uuid().nullable(),
}).strict();

export class MemberImplementationRepository {
  constructor(private readonly database: Database, private readonly historyCursorSecret: string) {
    cursorSecret(historyCursorSecret);
  }

  private async command<T>(
    actor: MemberActor,
    correlationId: string,
    parentDeadline: number,
    run: (
      query: <R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => Promise<readonly R[]>,
      lockQuery: <R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => Promise<readonly R[]>,
    ) => Promise<T>,
  ): Promise<T> {
    validateActor(actor);
    if (!uuid.test(correlationId)) throw new Error("IMPLEMENTATION_CORRELATION_INVALID");
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      lease = await acquireMemberReadClient(this.database.pool, performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs, parentDeadline);
      const query = async <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) =>
        (await runMemberReadQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, values)).rows;
      const lockQuery = async <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) =>
        (await runMemberReadLockQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.lockMs, parentDeadline, text, values)).rows;
      await query("begin");
      open = true;
      await query(
        "select set_config('app.account_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.membership_id',$3,true),set_config('app.actor_kind','member',true),set_config('app.correlation_id',$4,true),set_config('app.actor_role',$5,true),set_config('app.authenticated_at',$6,true)",
        [actor.accountId, actor.actorId, actor.membershipId, correlationId, actor.role, actor.authenticatedAt.toISOString()],
      );
      const value = await run(query, lockQuery);
      await throwIfMemberReadDeadlineExpired(lease, parentDeadline);
      await query("commit");
      open = false;
      return value;
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquired = lease;
        await runMemberReadCleanupQuery(acquired, MEMBER_READ_DEADLINES.cleanupMs, "rollback")
          .catch(async () => destroyMemberReadLease(acquired));
      }
      if (error instanceof DatabaseDependencyUnavailableError) throw error;
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      const mapped = safeError(error);
      if (mapped !== null) throw mapped;
      throw new ImplementationRepositoryError("IMPLEMENTATION_DEPENDENCY_FAILED");
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }

  async list(actor: MemberActor, correlationId: string, parentDeadline = memberReadParentDeadline()): Promise<ArtifactListResponse> {
    return this.command(actor, correlationId, parentDeadline, async (query) => {
      const rows = await query<{ result: unknown }>("select public.syntholo_implementation_list_v1() result");
      return ArtifactListResponseSchema.parse(rows[0]?.result);
    });
  }

  async get(actor: MemberActor, correlationId: string, artifactId: string, parentDeadline = memberReadParentDeadline()): Promise<ArtifactDetailResponse> {
    if (!uuid.test(artifactId)) throw new Error("IMPLEMENTATION_INPUT_INVALID");
    return this.command(actor, correlationId, parentDeadline, async (query) => {
      const rows = await query<{ result: unknown }>("select public.syntholo_implementation_get_v1($1) result", [artifactId]);
      return ArtifactDetailResponseSchema.parse(rows[0]?.result);
    });
  }

  async versions(actor: MemberActor, correlationId: string, artifactId: string, input: Readonly<{ limit: number; cursor?: string }>, parentDeadline = memberReadParentDeadline()): Promise<ArtifactVersionsResponse> {
    if (!uuid.test(artifactId) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new ImplementationRepositoryError("INVALID_CURSOR");
    const binding = {
      accountId: actor.accountId,
      actorId: actor.actorId,
      membershipId: actor.membershipId,
      artifactId,
      limit: input.limit,
    };
    const cursor = input.cursor === undefined ? null : decodeImplementationHistoryCursor(
      input.cursor,
      binding,
      this.historyCursorSecret,
    );
    return this.command(actor, correlationId, parentDeadline, async (query) => {
      const rows = await query<{ result: unknown }>("select public.syntholo_implementation_versions_v1($1,$2,$3,$4) result", [artifactId, cursor?.createdAt ?? null, cursor?.id ?? null, input.limit]);
      const internal = InternalHistorySchema.parse(rows[0]?.result);
      const nextCursor = internal.hasMore && internal.nextCreatedAt !== null && internal.nextId !== null
        ? encodeImplementationHistoryCursor(
          { createdAt: internal.nextCreatedAt, id: internal.nextId },
          binding,
          this.historyCursorSecret,
        )
        : null;
      return ArtifactVersionsResponseSchema.parse({ schemaVersion: 1, items: internal.items, nextCursor });
    });
  }

  async saveVersion(actor: MemberActor, correlationId: string, artifactId: string, input: SaveArtifactVersionRequest, idempotencyKey: string, parentDeadline = memberReadParentDeadline()): Promise<SaveArtifactVersionResponse> {
    if (!uuid.test(artifactId) || !/^[A-Za-z0-9._~-]{16,128}$/u.test(idempotencyKey)) throw new Error("IMPLEMENTATION_INPUT_INVALID");
    const parsedResult = SaveArtifactVersionRequestSchema.safeParse(input);
    if (!parsedResult.success) throw new ImplementationRepositoryError("IMPLEMENTATION_COMMAND_INVALID");
    const parsed = parsedResult.data;
    const requestHash = canonicalizeArtifactContent({ artifactId, expectedVersion: parsed.expectedVersion, state: parsed.state, content: parsed.content }).hash;
    return this.command(actor, correlationId, parentDeadline, async (_query, lockQuery) => {
      const rows = await lockQuery<{ result: unknown }>("select public.syntholo_implementation_save_version_v1($1,$2,$3,$4::jsonb,$5,$6) result", [artifactId, parsed.expectedVersion, parsed.state, JSON.stringify(parsed.content), idempotencyKey, requestHash]);
      const response = SaveArtifactVersionResponseSchema.parse(rows[0]?.result);
      if (response.version.contentHash !== canonicalizeArtifactContent(response.content).hash) {
        throw new Error("IMPLEMENTATION_RESULT_INVALID");
      }
      return response;
    });
  }
}

export class SystemImplementationRepository {
  constructor(private readonly database: Database) {}

  async seedWorkspace(
    input: Readonly<{ accountCourseAccessId: string; actorId: string; correlationId: string }>,
    signal?: AbortSignal,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<Readonly<{ kind: "seeded" | "duplicate" }>> {
    if (!uuid.test(input.accountCourseAccessId) || !identifier.test(input.actorId) || !uuid.test(input.correlationId)) {
      throw new SystemImplementationRepositoryError("IMPLEMENTATION_SEED_INPUT_INVALID");
    }
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      if (signal?.aborted === true) throw new DatabaseDependencyUnavailableError("parent_timeout");
      const acquisition = acquireMemberReadClient(
        this.database.pool,
        performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs,
        parentDeadline,
      );
      const acquired = signal === undefined ? { kind: "value" as const, value: await acquisition } : await raceAbort(acquisition, signal);
      if (acquired.kind === "aborted") {
        void acquisition.then((lateLease) => destroyMemberReadLease(lateLease).catch(() => undefined), () => undefined);
        throw new DatabaseDependencyUnavailableError("parent_timeout");
      }
      lease = acquired.value;
      const query = async <R extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
        lock = false,
      ) => {
        const operation = lock
          ? runMemberReadLockQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.lockMs, parentDeadline, text, values)
          : runMemberReadQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, values);
        const completed = signal === undefined ? { kind: "value" as const, value: await operation } : await raceAbort(operation, signal);
        if (completed.kind === "aborted") {
          void operation.catch(() => undefined);
          await destroyMemberReadLease(lease!);
          throw new DatabaseDependencyUnavailableError("parent_timeout");
        }
        return completed.value;
      };
      await query("begin");
      open = true;
      await query(
        "select set_config('app.actor_kind','system',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)",
        [input.actorId, input.correlationId],
      );
      const result = await query<{ outcome: unknown }>(
        "select public.syntholo_implementation_seed_workspace_v1($1) outcome",
        [input.accountCourseAccessId],
        true,
      );
      const outcome = z.enum(["seeded", "duplicate"]).safeParse(result.rows[0]?.outcome);
      if (!outcome.success) throw new SystemImplementationRepositoryError("IMPLEMENTATION_SEED_RESULT_INVALID");
      await throwIfMemberReadDeadlineExpired(lease, parentDeadline);
      await query("commit");
      open = false;
      return Object.freeze({ kind: outcome.data });
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquired = lease;
        await runMemberReadCleanupQuery(acquired, MEMBER_READ_DEADLINES.cleanupMs, "rollback")
          .catch(async () => destroyMemberReadLease(acquired));
      }
      if (error instanceof DatabaseDependencyUnavailableError) throw error;
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      if (error instanceof SystemImplementationRepositoryError) throw error;
      if (error instanceof Error && error.message === "IMPLEMENTATION_ACCESS_INVALID") {
        throw new SystemImplementationRepositoryError("IMPLEMENTATION_SEED_NOT_FOUND");
      }
      if (error instanceof Error && error.message === "IMPLEMENTATION_SEED_INTEGRITY") {
        throw new SystemImplementationRepositoryError("IMPLEMENTATION_SEED_RESULT_INVALID");
      }
      throw new SystemImplementationRepositoryError("IMPLEMENTATION_SEED_DEPENDENCY_FAILED");
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }
}

export class SystemImplementationRepositoryError extends Error {
  constructor(readonly code:
    | "IMPLEMENTATION_SEED_INPUT_INVALID"
    | "IMPLEMENTATION_SEED_NOT_FOUND"
    | "IMPLEMENTATION_SEED_RESULT_INVALID"
    | "IMPLEMENTATION_SEED_DEPENDENCY_FAILED") {
    super(code);
    this.name = "SystemImplementationRepositoryError";
  }
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
