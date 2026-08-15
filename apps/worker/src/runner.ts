import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  assertDatabaseCapability,
  checkDatabaseReadiness,
  createDatabase,
  HandlerReceiptRepository,
  JobRepository,
  OutboxProcessorRepository,
  PermanentOutboxDispatchError,
  WorkerContentMediaRepository,
  WorkerLearningRepository,
  WorkerImplementationRepository,
  WorkerCertificateRepository,
  CertificateStorageRecoveryPriorDecisionError,
  type ClassifiedJobFailure,
  type ClaimedJob,
  type HandlerReceiptClaim,
} from "@syntholo/database";
import {
  createMuxAssetManagementClient,
  createPrivateCertificateBlobStore,
  CertificateBlobError,
} from "@syntholo/integrations";
import {
  parseWorkerConfig,
  type RuntimeEnvironment,
  type WorkerConfig,
} from "./config.js";
import {
  createHandlerRegistry,
  FatalWorkerConsistencyError,
  HandlerFailure,
  type JobHandler,
} from "./handlers/index.js";
import { emitWorkerHealth, type WorkerHealthStatus } from "./health.js";
import { createMuxReconcileJobHandler } from "./handlers/content/mux.js";
import { createContentReadinessRecomputeHandler } from "./handlers/content/readiness-recompute.js";
import { createCertificatePrerequisiteRecordHandler } from "./handlers/learning/certificate-prerequisite-record.js";
import { createImplementationCompletionRecomputeHandler } from "./handlers/implementation/completion-recompute.js";
import { createCertificateGenerationHandler } from "./handlers/certificates/generate.js";
import {
  assertCertificateRendererReadiness,
  renderCertificatePdf,
} from "./handlers/certificates/render.js";

export type WorkerJob = Readonly<{
  id: string;
  type: string;
}>;

export function createWorkerId(host: string, processId: number, certificateCapable = false): string {
  if (!Number.isInteger(processId) || processId < 1) throw new Error("WORKER_ID_INVALID");
  const safeHost = host.replace(/[^A-Za-z0-9._:-]/gu, "-").replace(/^-+/u, "") || "host";
  const capability = certificateCapable ? "-certificate-v1" : "";
  const suffix = `-${processId}-${createHash("sha256").update(host).digest("hex").slice(0, 12)}${capability}`;
  return `${safeHost.slice(0, 128 - suffix.length)}${suffix}`;
}

export type HandlerReceiptPort = Readonly<{
  acquire(
    job: ClaimedJob,
    now: Date,
  ): Promise<HandlerReceiptClaim | Readonly<{ kind: "busy"; leaseExpiresAt: Date }> | Readonly<{ kind: "completed" }>>;
  abandon(
    claim: HandlerReceiptClaim,
    now: Date,
  ): Promise<Readonly<{ kind: "abandoned" | "stale_claim" }>>;
  complete(
    claim: HandlerReceiptClaim,
    now: Date,
  ): Promise<Readonly<{ kind: "completed" | "stale_claim" }>>;
}>;

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function createDomainEventJobHandler(
  receipts: HandlerReceiptPort,
  clock: Readonly<{ now(): Date }>,
  domainEventHandlers: Readonly<Record<string, (
    event: Readonly<{ eventId: string; handlerName: string }>,
    signal: AbortSignal,
  ) => Promise<void>>> = Object.freeze({
    foundation_audit_projection: async () => undefined,
    entitlement_reconciliation_queue: async () => undefined,
  }),
): JobHandler {
  return async (job, signal) => {
    const eventId = job.payload.eventId;
    const handlerName = job.payload.handlerName;
    if (
      typeof eventId !== "string"
      || !canonicalUuid.test(eventId)
      || typeof handlerName !== "string"
      || Object.keys(job.payload).sort().join(",") !== "eventId,handlerName"
      || domainEventHandlers[handlerName] === undefined
    ) {
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    }
    const domainHandler = domainEventHandlers[handlerName];
    if (domainHandler === undefined) {
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    }
    let receipt;
    try {
      receipt = await receipts.acquire(job, clock.now());
    } catch {
      throw new FatalWorkerConsistencyError();
    }
    if (receipt.kind === "completed") return;
    if (receipt.kind === "busy") {
      throw new HandlerFailure({
        code: "JOB_DEPENDENCY_UNAVAILABLE",
        permanent: false,
        retryAt: receipt.leaseExpiresAt,
      });
    }
    try {
      await domainHandler({ eventId, handlerName }, signal);
      const completed = await receipts.complete(receipt, clock.now());
      if (completed.kind !== "completed") throw new FatalWorkerConsistencyError();
    } catch (error) {
      if (error instanceof FatalWorkerConsistencyError) throw error;
      let abandoned;
      try {
        abandoned = await receipts.abandon(receipt, clock.now());
      } catch {
        throw new FatalWorkerConsistencyError();
      }
      if (abandoned.kind !== "abandoned") throw new FatalWorkerConsistencyError();
      throw error;
    }
  };
}

export type WorkerDependencies<TJob extends WorkerJob> = Readonly<{
  config: WorkerConfig;
  workerId: string;
  clock: Readonly<{ now(): Date }>;
  jobs: Readonly<{
    readonly heartbeatIntervalMs: number;
    claim(
      concurrency: number,
      workerId: string,
      now: Date,
    ): Promise<readonly TJob[]>;
    complete(
      job: TJob,
      now: Date,
    ): Promise<Readonly<{ kind: string }>>;
    extendLease(
      job: TJob,
      now: Date,
    ): Promise<Readonly<{ kind: string; leaseExpiresAt?: Date }>>;
    fail(
      job: TJob,
      failure: Readonly<{
        code: "JOB_DEPENDENCY_UNAVAILABLE" | "JOB_HANDLER_FAILED" | "JOB_INPUT_INVALID";
        permanent: boolean;
        retryAt?: Date;
      }>,
      now: Date,
      random: number,
    ): Promise<Readonly<{
      kind: string;
      runAt?: Date;
    }>>;
  }>;
  handlers: Readonly<{ handle(job: TJob, signal: AbortSignal): Promise<void> }>;
  random(): number;
  heartbeatWait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  fatalDrainTimeoutMs?: number;
  fatalDrainWait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  fatalSignal?: AbortSignal;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}>;

export function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function processJob<TJob extends WorkerJob>(
  dependencies: WorkerDependencies<TJob>,
  job: TJob,
  fatalSignals: readonly AbortSignal[],
): Promise<void> {
  const lifecycleController = new AbortController();
  const abortForFatalSibling = () => lifecycleController.abort();
  for (const fatalSignal of fatalSignals) {
    if (fatalSignal.aborted) lifecycleController.abort();
    else fatalSignal.addEventListener("abort", abortForFatalSibling, { once: true });
  }
  try {
  const heartbeat = (async () => {
    const wait = dependencies.heartbeatWait ?? abortableDelay;
    while (!lifecycleController.signal.aborted) {
      await wait(dependencies.jobs.heartbeatIntervalMs, lifecycleController.signal);
      if (lifecycleController.signal.aborted) return;
      const extended = await dependencies.jobs.extendLease(job, dependencies.clock.now());
      if (extended.kind !== "extended") throw new FatalWorkerConsistencyError();
    }
  })();
  const handler = dependencies.handlers.handle(job, lifecycleController.signal)
    .then(() => ({ kind: "handler_completed" as const }))
    .catch((error: unknown) => ({ error, kind: "handler_failed" as const }));
  const lease = heartbeat
    .then(() => ({ kind: "heartbeat_stopped" as const }))
    .catch((error: unknown) => ({ error, kind: "heartbeat_failed" as const }));
  const first = await Promise.race([handler, lease]);
  if (first.kind === "heartbeat_failed") {
    lifecycleController.abort();
    await Promise.race([
      handler,
      (dependencies.fatalDrainWait ?? abortableDelay)(
        dependencies.fatalDrainTimeoutMs ?? 5_000,
        new AbortController().signal,
      ),
    ]);
    throw new FatalWorkerConsistencyError();
  }
  if (first.kind === "heartbeat_stopped") {
    lifecycleController.abort();
    throw new FatalWorkerConsistencyError();
  }
  lifecycleController.abort();
  const leaseResult = await lease;
  if (leaseResult.kind !== "heartbeat_stopped") {
    throw new FatalWorkerConsistencyError();
  }
  if (first.kind === "handler_failed") {
    const handlerError = first.error;
    if (handlerError instanceof FatalWorkerConsistencyError) throw handlerError;
    const failure: ClassifiedJobFailure = handlerError instanceof HandlerFailure
      ? handlerError.failure
      : { code: "JOB_HANDLER_FAILED", permanent: false };
    const failed = await dependencies.jobs.fail(
      job,
      failure,
      dependencies.clock.now(),
      dependencies.random(),
    );
    if (failed.kind === "stale_claim") {
      throw new Error("WORKER_TRANSITION_FAILED");
    }
    return;
  }

  const completed = await dependencies.jobs.complete(
    job,
    dependencies.clock.now(),
  );
  if (completed.kind !== "completed") {
    throw new Error("WORKER_TRANSITION_FAILED");
  }
  } finally {
    for (const fatalSignal of fatalSignals) {
      fatalSignal.removeEventListener("abort", abortForFatalSibling);
    }
  }
}

export async function runWorker<TJob extends WorkerJob>(
  dependencies: WorkerDependencies<TJob>,
  signal: AbortSignal,
): Promise<void> {
  const config = parseWorkerConfig({
    DATABASE_URL: dependencies.config.databaseUrl,
    RELEASE_SHA: dependencies.config.releaseSha,
    WORKER_CONCURRENCY: String(dependencies.config.concurrency),
    WORKER_IDLE_DELAY_MS: String(dependencies.config.idleDelayMs),
    MUX_CONTENT_ENABLED: String(dependencies.config.mux?.enabled ?? false),
    ...(dependencies.config.mux?.tokenId === undefined ? {} : {
      MUX_ENVIRONMENT_ID: dependencies.config.mux.environmentId,
      MUX_RECONCILE_TOKEN_ID: dependencies.config.mux.tokenId,
      MUX_RECONCILE_TOKEN_SECRET: dependencies.config.mux.tokenSecret,
    }),
  });
  const wait = dependencies.wait ?? abortableDelay;

  while (!signal.aborted) {
    const jobs = await dependencies.jobs.claim(
      config.concurrency,
      dependencies.workerId,
      dependencies.clock.now(),
    );
    const batchController = new AbortController();
    let reportFailure!: (error: unknown) => void;
    const firstFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    const processing = jobs.map((job) =>
      processJob(
        dependencies,
        job,
        dependencies.fatalSignal === undefined
          ? [batchController.signal]
          : [batchController.signal, dependencies.fatalSignal],
      ).catch((error: unknown) => {
        reportFailure(error);
        throw error;
      })
    );
    const allSettled = Promise.allSettled(processing);
    const outcome = await Promise.race([
      allSettled.then((settled) => ({ kind: "settled" as const, settled })),
      firstFailure.then((error) => ({ error, kind: "failed" as const })),
    ]);
    if (outcome.kind === "failed") {
      batchController.abort();
      await Promise.race([
        allSettled,
        (dependencies.fatalDrainWait ?? abortableDelay)(
          dependencies.fatalDrainTimeoutMs ?? 5_000,
          new AbortController().signal,
        ),
      ]);
      throw new Error("WORKER_TRANSITION_FAILED");
    }
    if (outcome.settled.some(({ status }) => status === "rejected")) {
      throw new Error("WORKER_TRANSITION_FAILED");
    }

    if (jobs.length === 0 && !signal.aborted) {
      await wait(config.idleDelayMs, signal);
    }
  }
}

type WorkerRuntimeDependencies<TJob extends WorkerJob> = Omit<
  WorkerDependencies<TJob>,
  "config"
>;

export type OutboxPumpDependencies = Readonly<{
  config: WorkerConfig;
  workerId: string;
  clock: Readonly<{ now(): Date }>;
  outbox: Pick<OutboxProcessorRepository, "claim" | "dispatch" | "fail">;
  handlersForEvent(event: import("@syntholo/database").ClaimedOutboxEvent): readonly string[];
  random(): number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}>;

export function handlersForOutboxEvent(
  event: import("@syntholo/database").ClaimedOutboxEvent,
): readonly string[] {
  switch (event.eventType) {
    case "commerce.payment_paid.v1":
    case "entitlements.command_applied.v1":
    case "foundation.account_name_changed.v1":
    case "foundation.aggregate_created.v1":
    case "foundation.lock_lost.v1":
    case "foundation.notification_sent.v1":
      return Object.freeze(["foundation_audit_projection"]);
    case "entitlements.reconciliation_required.v1":
      return Object.freeze(["entitlement_reconciliation_queue"]);
    case "content.lesson_published.v1":
    case "content.course_published.v1":
    case "content.version_archived.v1":
    case "content.media_state_changed.v1":
    case "content.resource_state_changed.v1":
    case "content.readiness_approved.v1":
      return Object.freeze(["content.readiness_recompute"]);
    case "learning.course_completed.v1":
      return Object.freeze([
        "learning.certificate_prerequisite_record",
        "implementation.completion_recompute",
      ]);
    case "implementation.artifact_version_saved.v1":
    case "implementation.program_completed.v1":
      return Object.freeze(["foundation_audit_projection"]);
    default:
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
  }
}

export async function runOutboxPump(
  dependencies: OutboxPumpDependencies,
  signal: AbortSignal,
): Promise<void> {
  const wait = dependencies.wait ?? abortableDelay;
  while (!signal.aborted) {
    const claims = await dependencies.outbox.claim(
      dependencies.config.concurrency,
      dependencies.workerId,
      dependencies.clock.now(),
    );
    const settled = await Promise.allSettled(claims.map(async (claim) => {
      let transitioned;
      try {
        transitioned = await dependencies.outbox.dispatch(
          claim,
          dependencies.handlersForEvent(claim),
          dependencies.clock.now(),
        );
      } catch (error) {
        const failed = await dependencies.outbox.fail(
          claim,
          dependencies.clock.now(),
          { permanent: error instanceof PermanentOutboxDispatchError
            || (error instanceof HandlerFailure && error.failure.permanent) },
          dependencies.random(),
        );
        if (failed.kind === "stale_claim") throw new Error("WORKER_TRANSITION_FAILED");
        return;
      }
      if (transitioned.kind === "stale_claim") {
        throw new Error("WORKER_TRANSITION_FAILED");
      }
    }));
    if (settled.some(({ status }) => status === "rejected")) {
      throw new Error("WORKER_TRANSITION_FAILED");
    }
    if (claims.length === 0 && !signal.aborted) {
      await wait(dependencies.config.idleDelayMs, signal);
    }
  }
}

export async function superviseWorkerPumps(
  controller: AbortController,
  pumps: readonly (() => Promise<void>)[],
  options?: Readonly<{
    abortActive?(): void;
    close(): Promise<void>;
    fatalDrainTimeoutMs: number;
    fatalDrainWait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
    forceTerminate(exitCode: 1): void;
  }>,
): Promise<void> {
  let reportFailure!: (error: unknown) => void;
  const firstFailure = new Promise<unknown>((resolve) => {
    reportFailure = resolve;
  });
  const running = pumps.map(async (pump) => {
    try {
      await pump();
    } catch (error) {
      controller.abort();
      reportFailure(error);
      throw error;
    }
  });
  const allSettled = Promise.allSettled(running);
  const outcome = await Promise.race([
    allSettled.then((settled) => ({ kind: "settled" as const, settled })),
    firstFailure.then((error) => ({ error, kind: "failed" as const })),
  ]);
  if (outcome.kind === "failed") {
    controller.abort();
    options?.abortActive?.();
    if (options === undefined) {
      await allSettled;
    } else {
      const drainedAndClosed = allSettled.then(async () => options.close());
      await Promise.race([
        drainedAndClosed.catch(() => undefined),
        (options.fatalDrainWait ?? abortableDelay)(
          options.fatalDrainTimeoutMs,
          new AbortController().signal,
        ),
      ]);
      options.forceTerminate(1);
    }
    throw outcome.error;
  }
  const failed = outcome.settled.find((result): result is PromiseRejectedResult =>
    result.status === "rejected"
  );
  if (failed) throw failed.reason;
  if (options !== undefined) await options.close();
}

export async function runCertificatePromoter(
  certificates: Pick<WorkerCertificateRepository, "promote">,
  signal: AbortSignal,
  wait: (delayMs: number, signal: AbortSignal) => Promise<void> = abortableDelay,
): Promise<void> {
  while (!signal.aborted) {
    const result = await certificates.promote(100, signal);
    if (signal.aborted) return;
    await wait(result.promoted === 100 ? 1_000 : 60_000, signal);
  }
}

export async function runCertificateRecovery(
  certificates: Pick<WorkerCertificateRepository,
    "listStorageRetryCandidates" | "retry" | "rejectStorageRecovery">,
  blob: Pick<ReturnType<typeof createPrivateCertificateBlobStore>, "reconcileUpload">,
  render: typeof renderCertificatePdf,
  signal: AbortSignal,
  wait: (delayMs: number, signal: AbortSignal) => Promise<void> = abortableDelay,
): Promise<void> {
  const decide = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      if (error instanceof CertificateStorageRecoveryPriorDecisionError) return;
      throw error;
    }
  };
  while (!signal.aborted) {
    const candidates = await certificates.listStorageRetryCandidates(25, signal);
    for (const candidate of candidates) {
      if (signal.aborted) return;
      let bytes: Uint8Array;
      try {
        bytes = await render({
          recipientName: candidate.recipientName,
          businessName: candidate.businessName,
          courseTitle: candidate.courseTitle,
          courseVersion: candidate.courseVersion,
          completedAt: candidate.completedAt,
        });
      } catch (error) {
        if (!(error instanceof Error) || ![
          "CERTIFICATE_RENDER_INPUT_INVALID",
          "CERTIFICATE_RENDER_GLYPH_UNAVAILABLE",
          "CERTIFICATE_RENDER_FONT_AUTHORITY_INVALID",
        ].includes(error.message)) throw error;
        await decide(() => certificates.rejectStorageRecovery({
          certificateId: candidate.certificateId,
          recoveryJobId: candidate.recoveryJobId,
          failedAttempt: candidate.failedAttempt,
          failedGeneration: candidate.failedGeneration,
          reason: "render_authority_invalid",
        }, signal));
        continue;
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const pathname = `certificates/v1/${candidate.accountId}/${candidate.courseCompletionId}.pdf`;
      try {
        const object = await blob.reconcileUpload({
          pathname,
          expected: { byteLength: bytes.byteLength, sha256 },
          signal,
        });
        await decide(() => certificates.retry({
          certificateId: candidate.certificateId,
          recoveryJobId: candidate.recoveryJobId,
          failedAttempt: candidate.failedAttempt,
          failedGeneration: candidate.failedGeneration,
          objectState: "matching",
          byteLength: bytes.byteLength,
          sha256,
          etag: object.etag,
        }, signal));
      } catch (error) {
        if (!(error instanceof CertificateBlobError)) throw error;
        if (error.retryable) continue;
        if (error.message === "CERTIFICATE_BLOB_NOT_FOUND") {
          await decide(() => certificates.retry({
            certificateId: candidate.certificateId,
            recoveryJobId: candidate.recoveryJobId,
            failedAttempt: candidate.failedAttempt,
            failedGeneration: candidate.failedGeneration,
            objectState: "absent",
            byteLength: bytes.byteLength,
            sha256,
            etag: null,
          }, signal));
          continue;
        }
        if (["CERTIFICATE_BLOB_CONSISTENCY_INCIDENT", "CERTIFICATE_BLOB_PROVIDER_SHAPE_INVALID"]
          .includes(error.message)) {
          await decide(() => certificates.rejectStorageRecovery({
            certificateId: candidate.certificateId,
            recoveryJobId: candidate.recoveryJobId,
            failedAttempt: candidate.failedAttempt,
            failedGeneration: candidate.failedGeneration,
            reason: error.message === "CERTIFICATE_BLOB_PROVIDER_SHAPE_INVALID"
              ? "provider_shape_invalid"
              : "object_mismatch",
          }, signal));
          continue;
        }
        throw new FatalWorkerConsistencyError();
      }
    }
    if (signal.aborted) return;
    await wait(candidates.length === 25 ? 1_000 : 60_000, signal);
  }
}

export type StartWorkerOptions<TJob extends WorkerJob> = Readonly<{
  env?: RuntimeEnvironment;
  signal: AbortSignal;
  createDependencies(
    config: WorkerConfig,
  ): WorkerRuntimeDependencies<TJob> | Promise<WorkerRuntimeDependencies<TJob>>;
}>;

export async function startWorker<TJob extends WorkerJob>(
  options: StartWorkerOptions<TJob>,
): Promise<void> {
  const config = parseWorkerConfig(options.env ?? process.env);
  const dependencies = await options.createDependencies(config);
  await runWorker(
    {
      ...dependencies,
      config,
    },
    options.signal,
  );
}

export async function establishWorkerReadiness(
  check: () => Promise<void>,
  signal: AbortSignal,
  markReady: () => void,
): Promise<boolean> {
  await check();
  if (signal.aborted) return false;
  markReady();
  return true;
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const fatalController = new AbortController();
  const config = parseWorkerConfig(process.env);
  let healthStatus: WorkerHealthStatus = "starting";
  const transition = (status: WorkerHealthStatus) => {
    if (healthStatus === status) return;
    healthStatus = status;
    emitWorkerHealth(config.releaseSha, status);
  };
  const stop = () => {
    transition("draining");
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const database = createDatabase({
    applicationName: `syntholo-worker-${config.releaseSha}`,
    url: config.databaseUrl,
  });
  let supervisorOwnsClose = false;
  try {
    const workerId = createWorkerId(hostname(), process.pid, config.certificateBlob !== undefined);
    const clock = { now: () => new Date() };
    const receipts = new HandlerReceiptRepository(database, { leaseMs: 60_000 });
    const content = new WorkerContentMediaRepository(database);
    const learning = new WorkerLearningRepository(database);
    const implementation = new WorkerImplementationRepository(database);
    const certificates = new WorkerCertificateRepository(database);
    const mux = config.mux?.enabled === true;
    if (mux && (config.mux.environmentId === undefined
      || config.mux.tokenId === undefined || config.mux.tokenSecret === undefined)) {
      throw new Error("WORKER_CONFIG_INVALID");
    }
    const management = mux ? createMuxAssetManagementClient({
      environmentId: config.mux?.environmentId ?? "",
      tokenId: config.mux?.tokenId ?? "",
      tokenSecret: config.mux?.tokenSecret ?? "",
    }) : null;
    const muxHandler = mux && management !== null
      ? createMuxReconcileJobHandler({ enabled: true, management, repository: content })
      : createMuxReconcileJobHandler({ enabled: false, management: null, repository: content });
    const certificateBlob = config.certificateBlob === undefined
      ? createPrivateCertificateBlobStore({
        enabled: false,
        environment: "staging",
        token: "",
        storeIds: { staging: "", production: "" },
      })
      : createPrivateCertificateBlobStore(config.certificateBlob);
    const handlers = createHandlerRegistry({
      "foundation.domain_event_handler.v1": createDomainEventJobHandler(receipts, clock, {
        foundation_audit_projection: async () => undefined,
        entitlement_reconciliation_queue: async () => undefined,
        "content.readiness_recompute": createContentReadinessRecomputeHandler(content),
        "learning.certificate_prerequisite_record": createCertificatePrerequisiteRecordHandler(learning),
        "implementation.completion_recompute": createImplementationCompletionRecomputeHandler(implementation),
      }),
      "content.mux_reconcile.v1": muxHandler,
      ...(config.certificateBlob === undefined ? {} : {
        "learning.course_completed.certificate.v1": createCertificateGenerationHandler({
          blob: certificateBlob,
          render: renderCertificatePdf,
          repository: certificates,
        }),
      }),
    });
    const jobs = new JobRepository(database, { leaseMs: 60_000 });
    const outbox = new OutboxProcessorRepository(database, { leaseMs: 60_000 });
    const ready = await establishWorkerReadiness(async () => {
      await assertDatabaseCapability(database, "syntholo_worker");
      await checkDatabaseReadiness(database, "syntholo_worker");
      if (config.certificateBlob !== undefined) await assertCertificateRendererReadiness();
    }, controller.signal, () => transition("ready"));
    if (!ready) return;
    supervisorOwnsClose = true;
    await superviseWorkerPumps(controller, [
      () => runWorker({
        clock,
        config,
        fatalSignal: fatalController.signal,
        handlers,
        jobs,
        random: Math.random,
        workerId,
      }, controller.signal),
      () => runOutboxPump({
        clock,
        config,
        handlersForEvent: handlersForOutboxEvent,
        outbox,
        random: Math.random,
        workerId,
      }, controller.signal),
      ...(config.certificateBlob === undefined ? [] : [
        () => runCertificatePromoter(certificates, controller.signal),
        () => runCertificateRecovery(certificates, certificateBlob, renderCertificatePdf, controller.signal),
      ]),
    ], {
      abortActive: () => fatalController.abort(),
      close: () => database.close(),
      fatalDrainTimeoutMs: 5_000,
      forceTerminate: (exitCode) => process.exit(exitCode),
    });
  } finally {
    controller.abort();
    if (!supervisorOwnsClose) await database.close();
    if (healthStatus !== "starting") transition("stopped");
  }
}

if (isMainModule()) {
  void main().catch(() => {
    process.stderr.write("WORKER_STARTUP_FAILED\n");
    process.exitCode = 1;
  });
}
