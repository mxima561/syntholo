import type { ClaimedJob } from "@syntholo/database";
import { MuxManagementError, type MuxAssetManagementPort } from "@syntholo/integrations";
import { HandlerFailure, type JobHandler } from "../index.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type Target = Readonly<{
  kind: "current";
  mediaAssetId: string;
  environmentId: string;
  providerAssetId: string;
  requestedRevision: number;
}> | Readonly<{ kind: "state_changed" }>;
// A closed database command may prove the provider object is no longer reconcilable.
type TerminalTarget = Readonly<{ kind: "terminal" }>;

type Snapshot = Awaited<ReturnType<MuxAssetManagementPort["retrieveAsset"]>>;

export type MuxReconcileRepositoryPort = Readonly<{
  loadTarget(input: Readonly<{ mediaAssetId: string; requestedRevision: number }>): Promise<Target | TerminalTarget>;
  apply(input: Readonly<{
    actorId: string;
    correlationId: string;
    mediaAssetId: string;
    expectedRevision: number;
    snapshot: Snapshot;
  }>): Promise<Readonly<{ kind: "applied" | "state_changed" }>>;
}>;

export function createMuxReconcileJobHandler(dependencies:
  | Readonly<{
    enabled: false;
    management: null;
    repository: MuxReconcileRepositoryPort;
  }>
  | Readonly<{
    enabled: true;
    management: MuxAssetManagementPort;
    repository: MuxReconcileRepositoryPort;
  }>): JobHandler {
  return async (job: ClaimedJob, signal: AbortSignal) => {
    if (job.type !== "content.mux_reconcile.v1"
      || Object.keys(job.payload).sort().join(",") !== "mediaAssetId,requestedRevision"
      || typeof job.payload.mediaAssetId !== "string" || !uuid.test(job.payload.mediaAssetId)
      || typeof job.payload.requestedRevision !== "number"
      || !Number.isSafeInteger(job.payload.requestedRevision)
      || job.payload.requestedRevision < 0) {
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    }
    if (!dependencies.enabled) {
      throw new HandlerFailure({ code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: true });
    }
    let target: Target | TerminalTarget;
    try {
      target = await dependencies.repository.loadTarget({
        mediaAssetId: job.payload.mediaAssetId,
        requestedRevision: job.payload.requestedRevision,
      });
    } catch {
      throw new HandlerFailure({ code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false });
    }
    if (target.kind === "terminal") {
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    }
    if (target.kind === "state_changed") return;
    let snapshot: Snapshot;
    try {
      snapshot = await dependencies.management.retrieveAsset(target.providerAssetId, signal);
    } catch (error) {
      if (error instanceof MuxManagementError && error.terminal) {
        throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
      }
      throw new HandlerFailure({ code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false });
    }
    if (snapshot.environmentId !== target.environmentId
      || snapshot.providerAssetId !== target.providerAssetId) {
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    }
    try {
      await dependencies.repository.apply({
        actorId: job.sourceActorId,
        correlationId: job.correlationId,
        mediaAssetId: target.mediaAssetId,
        expectedRevision: target.requestedRevision,
        snapshot,
      });
    } catch {
      throw new HandlerFailure({ code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false });
    }
  };
}
