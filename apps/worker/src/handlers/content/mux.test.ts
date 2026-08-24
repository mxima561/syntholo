import { describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "@syntholo/database";
import { MuxManagementError } from "@syntholo/integrations";
import {
  createMuxReconcileJobHandler,
  type MuxReconcileRepositoryPort,
} from "./mux.js";

const job = {
  id: "10000000-0000-4000-8000-000000000001",
  accountId: null,
  attempt: 1,
  claimGeneration: 1,
  claimToken: "10000000-0000-4000-8000-000000000002",
  correlationId: "10000000-0000-4000-8000-000000000003",
  idempotencyKey: "content-mux-reconcile:test",
  leaseExpiresAt: new Date("2026-08-14T18:01:00.000Z"),
  maxAttempts: 5,
  payload: { mediaAssetId: "10000000-0000-4000-8000-000000000010", requestedRevision: 2 },
  sourceActorId: "mux-webhook",
  sourceActorType: "system",
  type: "content.mux_reconcile.v1",
  workerId: "worker-test",
} as ClaimedJob;

describe("Mux reconciliation worker handler", () => {
  it("loads the closed target, retrieves authoritative state, and applies it", async () => {
    const apply = vi.fn(async (
      _input: Parameters<MuxReconcileRepositoryPort["apply"]>[0],
    ) => {
      void _input;
      return { kind: "applied" as const };
    });
    const handler = createMuxReconcileJobHandler({
      enabled: true,
      management: { createDirectUpload: vi.fn(), retrieveUpload: vi.fn(), retrieveAsset: vi.fn(async () => ({
        environmentId: "env_staging",
        providerAssetId: "asset_123",
        state: "ready" as const,
        signedPolicyPlaybackId: "playback_123",
        durationMilliseconds: 480_000,
        aspectRatio: "16:9",
        tracks: [{
          providerTrackId: "track_123",
          state: "ready" as const,
          language: "en",
          label: "English",
          closedCaptions: true,
          source: "human" as const,
        }],
      })) },
      repository: {
        loadTarget: vi.fn(async () => ({
          kind: "current" as const,
          mediaAssetId: job.payload.mediaAssetId as string,
          environmentId: "env_staging",
          providerAssetId: "asset_123",
          requestedRevision: 2,
        })),
        apply,
      },
    });
    await handler(job, new AbortController().signal);
    expect(apply).toHaveBeenCalledOnce();
    const applied = apply.mock.calls[0]?.[0];
    expect(applied?.actorId).toBe(job.sourceActorId);
    expect(applied?.correlationId).toBe(job.correlationId);
    expect(applied?.mediaAssetId).toBe(job.payload.mediaAssetId);
    expect(applied?.expectedRevision).toBe(2);
    expect(applied?.snapshot.providerAssetId).toBe("asset_123");
  });

  it("fails closed when disabled and permanently rejects a wrong environment", async () => {
    await expect(createMuxReconcileJobHandler({
      enabled: false,
      management: null,
      repository: { loadTarget: vi.fn(), apply: vi.fn() },
    })(job, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: true },
    });

    const handler = createMuxReconcileJobHandler({
      enabled: true,
      management: { createDirectUpload: vi.fn(), retrieveUpload: vi.fn(), retrieveAsset: vi.fn(async () => ({
        environmentId: "env_production",
        providerAssetId: "asset_123",
        state: "ready" as const,
        signedPolicyPlaybackId: "playback_123",
        durationMilliseconds: 480_000,
        aspectRatio: "16:9",
        tracks: [],
      })) },
      repository: {
        loadTarget: vi.fn(async () => ({
          kind: "current" as const,
          mediaAssetId: job.payload.mediaAssetId as string,
          environmentId: "env_staging",
          providerAssetId: "asset_123",
          requestedRevision: 2,
        })),
        apply: vi.fn(),
      },
    });
    await expect(handler(job, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: "JOB_INPUT_INVALID", permanent: true },
    });
  });

  it("permanently classifies provider terminal failures", async () => {
    const handler = createMuxReconcileJobHandler({
      enabled: true,
      management: { createDirectUpload: vi.fn(), retrieveUpload: vi.fn(), retrieveAsset: vi.fn(async () => {
        throw new MuxManagementError("MUX_MANAGEMENT_OBJECT_TERMINAL", true);
      }) },
      repository: {
        loadTarget: vi.fn(async () => ({
          kind: "current" as const,
          mediaAssetId: job.payload.mediaAssetId as string,
          environmentId: "env_staging",
          providerAssetId: "asset_123",
          requestedRevision: 2,
        })),
        apply: vi.fn(),
      },
    });
    await expect(handler(job, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: "JOB_INPUT_INVALID", permanent: true },
    });
  });

  it("permanently classifies a closed-command terminal target", async () => {
    const handler = createMuxReconcileJobHandler({
      enabled: true,
      management: { createDirectUpload: vi.fn(), retrieveUpload: vi.fn(), retrieveAsset: vi.fn() },
      repository: {
        loadTarget: vi.fn(async () => ({ kind: "terminal" as const })),
        apply: vi.fn(),
      },
    });
    await expect(handler(job, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: "JOB_INPUT_INVALID", permanent: true },
    });
  });
});
