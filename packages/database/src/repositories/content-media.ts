import {
  MuxWebhookEventSchema,
  type MuxWebhookEvent,
} from "@syntholo/contracts/content";
import type { Database } from "../client.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

export type ApplyMuxEventInput = Readonly<{
  actorId: string;
  correlationId: string;
  expectedEnvironmentId: string;
  event: MuxWebhookEvent;
}>;

export type MuxEventApplyResult = Readonly<{
  outcome: "applied" | "duplicate" | "ignored" | "ordered_no_change" | "stale";
  mediaAssetId: string | null;
  assetRevision: number | null;
  trackRevision: number | null;
}>;

export class SystemMuxEventRepository {
  constructor(private readonly database: Database) {}

  async apply(input: ApplyMuxEventInput): Promise<MuxEventApplyResult> {
    const parsed = MuxWebhookEventSchema.safeParse(input.event);
    if (!parsed.success || !identifier.test(input.actorId)
      || !uuid.test(input.correlationId)
      || !identifier.test(input.expectedEnvironmentId)
      || input.expectedEnvironmentId !== parsed.data.environmentId) {
      throw new Error("MUX_EVENT_APPLY_INVALID");
    }
    const event = parsed.data;
    const track = event.track;
    const client = await this.database.pool.connect();
    let open = false;
    try {
      await client.query("begin");
      open = true;
      await client.query(
        "select set_config('app.actor_kind','system',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)",
        [input.actorId, input.correlationId],
      );
      const result = await client.query<{
        outcome: MuxEventApplyResult["outcome"];
        media_asset_id: string | null;
        asset_revision: number | null;
        track_revision: number | null;
      }>(
        "select * from public.syntholo_mux_apply_event_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
        [
          input.expectedEnvironmentId, event.eventId, event.type,
          event.environmentId, new Date(event.occurredAt),
          event.asset.providerAssetId, event.asset.state,
          event.asset.signedPolicyPlaybackId, event.asset.durationMilliseconds,
          event.asset.aspectRatio, track?.providerTrackId ?? null,
          track?.state ?? null, track?.language ?? null, track?.label ?? null,
          track?.closedCaptions ?? null, track?.source ?? null, null,
        ],
      );
      const row = result.rows[0];
      if (row === undefined
        || !["applied", "duplicate", "ignored", "ordered_no_change", "stale"].includes(row.outcome)
        || (row.media_asset_id !== null && !uuid.test(row.media_asset_id))
        || (row.asset_revision !== null && (!Number.isSafeInteger(row.asset_revision) || row.asset_revision < 0))
        || (row.track_revision !== null && (!Number.isSafeInteger(row.track_revision) || row.track_revision < 0))) {
        throw new Error("MUX_EVENT_APPLY_RESULT_INVALID");
      }
      await client.query("commit");
      open = false;
      return Object.freeze({
        outcome: row.outcome,
        mediaAssetId: row.media_asset_id,
        assetRevision: row.asset_revision,
        trackRevision: row.track_revision,
      });
    } catch {
      if (open) await client.query("rollback").catch(() => undefined);
      throw new Error("MUX_EVENT_APPLY_FAILED");
    } finally {
      client.release();
    }
  }
}

export type ImportMuxAssetInput = Readonly<{
  actorId: string;
  correlationId: string;
  environmentId: string;
  providerAssetId: string;
}>;

export type ImportedMuxAsset = Readonly<{
  mediaAssetId: string;
  environmentId: string;
  providerAssetId: string;
  state: "waiting" | "preparing" | "ready" | "errored" | "deleted";
  signedPolicyPlaybackId: string;
  readinessRevision: number;
}>;

export class StaffMuxAssetRepository {
  constructor(private readonly database: Database) {}

  async import(input: ImportMuxAssetInput): Promise<ImportedMuxAsset> {
    if (!uuid.test(input.actorId) || !uuid.test(input.correlationId)
      || !identifier.test(input.environmentId) || !identifier.test(input.providerAssetId)) {
      throw new Error("MUX_ASSET_IMPORT_INVALID");
    }
    const client = await this.database.pool.connect();
    let open = false;
    try {
      await client.query("begin");
      open = true;
      await client.query(
        "select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)",
        [input.actorId, input.correlationId],
      );
      const result = await client.query<{
        id: string;
        environment_id: string;
        provider_asset_id: string;
        state: ImportedMuxAsset["state"];
        signed_policy_playback_id: string | null;
        readiness_revision: number;
      }>(
        "select (asset).id,(asset).environment_id,(asset).provider_asset_id,(asset).state,(asset).signed_policy_playback_id,(asset).readiness_revision from (select public.syntholo_content_import_mux_asset_v1($1,$2) asset) imported",
        [input.environmentId, input.providerAssetId],
      );
      const row = result.rows[0];
      if (row === undefined || !uuid.test(row.id)
        || row.environment_id !== input.environmentId || row.provider_asset_id !== input.providerAssetId
        || !["waiting", "preparing", "ready", "errored", "deleted"].includes(row.state)
        || row.signed_policy_playback_id === null || !identifier.test(row.signed_policy_playback_id)
        || !Number.isSafeInteger(row.readiness_revision) || row.readiness_revision < 0) {
        throw new Error("MUX_ASSET_IMPORT_RESULT_INVALID");
      }
      await client.query("commit");
      open = false;
      return Object.freeze({
        mediaAssetId: row.id,
        environmentId: row.environment_id,
        providerAssetId: row.provider_asset_id,
        state: row.state,
        signedPolicyPlaybackId: row.signed_policy_playback_id,
        readinessRevision: row.readiness_revision,
      });
    } catch {
      if (open) await client.query("rollback").catch(() => undefined);
      throw new Error("MUX_ASSET_IMPORT_FAILED");
    } finally {
      client.release();
    }
  }
}

export type MuxReconcileTarget = Readonly<{
  kind: "current";
  mediaAssetId: string;
  environmentId: string;
  providerAssetId: string;
  requestedRevision: number;
}> | Readonly<{ kind: "state_changed" | "terminal" }>;

export type MuxReconciliationSnapshot = Readonly<{
  environmentId: string;
  providerAssetId: string;
  state: "waiting" | "preparing" | "ready" | "errored" | "deleted";
  signedPolicyPlaybackId: string | null;
  durationMilliseconds: number | null;
  aspectRatio: string | null;
  tracks: readonly Readonly<{
    providerTrackId: string;
    state: "preparing" | "ready" | "errored" | "deleted";
    language: string;
    label: string;
    closedCaptions: boolean;
    source: "human" | "mux_generated";
  }>[];
}>;

function safeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validReconciliationSnapshot(value: MuxReconciliationSnapshot): boolean {
  return identifier.test(value.environmentId) && identifier.test(value.providerAssetId)
    && ["waiting", "preparing", "ready", "errored", "deleted"].includes(value.state)
    && (value.signedPolicyPlaybackId === null || identifier.test(value.signedPolicyPlaybackId))
    && (value.durationMilliseconds === null
      || (Number.isSafeInteger(value.durationMilliseconds) && value.durationMilliseconds > 0
        && value.durationMilliseconds <= 86_400_000))
    && (value.aspectRatio === null || /^[1-9][0-9]{0,4}:[1-9][0-9]{0,4}$/u.test(value.aspectRatio))
    && Array.isArray(value.tracks) && value.tracks.length <= 100
    && value.tracks.every((track) => identifier.test(track.providerTrackId)
      && ["preparing", "ready", "errored", "deleted"].includes(track.state)
      && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(track.language)
      && track.label.trim().length > 0 && Buffer.byteLength(track.label) <= 100
      && typeof track.closedCaptions === "boolean"
      && (track.source === "human" || track.source === "mux_generated"));
}

export class WorkerContentMediaRepository {
  constructor(private readonly database: Database) {}

  async loadTarget(input: Readonly<{
    mediaAssetId: string;
    requestedRevision: number;
  }>): Promise<MuxReconcileTarget> {
    if (!uuid.test(input.mediaAssetId) || !safeRevision(input.requestedRevision)) {
      throw new Error("MUX_RECONCILE_TARGET_INVALID");
    }
    try {
      const result = await this.database.pool.query<{
        outcome: "current" | "state_changed" | "terminal";
        media_asset_id: string | null;
        environment_id: string | null;
        provider_asset_id: string | null;
        requested_revision: number | null;
      }>(
        "select * from public.syntholo_content_load_mux_reconcile_target_v1($1,$2)",
        [input.mediaAssetId, input.requestedRevision],
      );
      const row = result.rows[0];
      if (row?.outcome === "state_changed") return Object.freeze({ kind: "state_changed" });
      if (row?.outcome === "terminal") return Object.freeze({ kind: "terminal" });
      if (row?.outcome !== "current" || row.media_asset_id !== input.mediaAssetId
        || row.environment_id === null || !identifier.test(row.environment_id)
        || row.provider_asset_id === null || !identifier.test(row.provider_asset_id)
        || row.requested_revision !== input.requestedRevision) {
        throw new Error("MUX_RECONCILE_TARGET_RESULT_INVALID");
      }
      return Object.freeze({
        kind: "current",
        mediaAssetId: row.media_asset_id,
        environmentId: row.environment_id,
        providerAssetId: row.provider_asset_id,
        requestedRevision: row.requested_revision,
      });
    } catch {
      throw new Error("MUX_RECONCILE_TARGET_FAILED");
    }
  }

  async apply(input: Readonly<{
    actorId: string;
    correlationId: string;
    mediaAssetId: string;
    expectedRevision: number;
    snapshot: MuxReconciliationSnapshot;
  }>): Promise<Readonly<{ kind: "applied" | "state_changed" }>> {
    if (!identifier.test(input.actorId) || !uuid.test(input.correlationId)
      || !uuid.test(input.mediaAssetId) || !safeRevision(input.expectedRevision)
      || !validReconciliationSnapshot(input.snapshot)) {
      throw new Error("MUX_RECONCILE_APPLY_INVALID");
    }
    try {
      const tracks = input.snapshot.tracks.map((track) => ({
        providerTrackId: track.providerTrackId,
        state: track.state,
        language: track.language,
        label: track.label,
        closedCaptions: track.closedCaptions,
        source: track.source,
      }));
      const result = await this.database.pool.query<{ outcome: "applied" | "state_changed" }>(
        "select outcome from public.syntholo_content_apply_mux_reconciliation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
        [
          input.actorId, input.correlationId, input.mediaAssetId,
          input.expectedRevision, input.snapshot.environmentId,
          input.snapshot.providerAssetId, input.snapshot.state,
          input.snapshot.signedPolicyPlaybackId, input.snapshot.durationMilliseconds,
          input.snapshot.aspectRatio, JSON.stringify(tracks),
        ],
      );
      const outcome = result.rows[0]?.outcome;
      if (outcome !== "applied" && outcome !== "state_changed") {
        throw new Error("MUX_RECONCILE_APPLY_RESULT_INVALID");
      }
      return Object.freeze({ kind: outcome });
    } catch {
      throw new Error("MUX_RECONCILE_APPLY_FAILED");
    }
  }

  async recompute(input: Readonly<{
    eventId: string;
    handlerName: "content.readiness_recompute";
  }>): Promise<Readonly<{ kind: "evaluated" }>> {
    if (!uuid.test(input.eventId) || input.handlerName !== "content.readiness_recompute") {
      throw new Error("CONTENT_READINESS_EVENT_INVALID");
    }
    try {
      const result = await this.database.pool.query<{ outcome: string }>(
        "select outcome from public.syntholo_content_recompute_readiness_event_v1($1,$2)",
        [input.eventId, input.handlerName],
      );
      if (result.rows[0]?.outcome !== "evaluated") {
        throw new Error("CONTENT_READINESS_RESULT_INVALID");
      }
      return Object.freeze({ kind: "evaluated" });
    } catch {
      throw new Error("CONTENT_READINESS_RECOMPUTE_FAILED");
    }
  }
}
