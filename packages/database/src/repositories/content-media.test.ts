import { describe, expect, it, vi } from "vitest";
import {
  StaffMuxAssetRepository,
  SystemMuxEventRepository,
  WorkerContentMediaRepository,
} from "./content-media.js";

const event = {
  eventId: "evt_123",
  type: "video.asset.ready",
  environmentId: "env_staging",
  occurredAt: "2026-08-14T18:00:00.000Z",
  asset: {
    providerAssetId: "asset_123",
    state: "ready",
    signedPolicyPlaybackId: "playback_123",
    durationMilliseconds: 480_000,
    aspectRatio: "16:9",
  },
  track: null,
} as const;

describe("system Mux event repository", () => {
  it("applies one normalized event through only the closed system command", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        return text.includes("syntholo_mux_apply_event_v1")
          ? { rows: [{ outcome: "applied", media_asset_id: "10000000-0000-4000-8000-000000000001", asset_revision: 1, track_revision: null }] }
          : { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new SystemMuxEventRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.apply({
      actorId: "mux-webhook",
      correlationId: "40000000-0000-4000-8000-000000000001",
      expectedEnvironmentId: "env_staging",
      event,
    })).resolves.toEqual({
      outcome: "applied",
      mediaAssetId: "10000000-0000-4000-8000-000000000001",
      assetRevision: 1,
      trackRevision: null,
    });
    expect(queries.map(({ text }) => text.trim().split(/\s+/u)[0])).toEqual([
      "begin", "select", "select", "commit",
    ]);
    expect(queries[2]?.values).toEqual([
      "env_staging", "evt_123", "video.asset.ready", "env_staging",
      new Date("2026-08-14T18:00:00.000Z"), "asset_123", "ready",
      "playback_123", 480_000, "16:9", null, null, null, null, null, null, null,
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and returns one safe error without provider or database details", async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("syntholo_mux_apply_event_v1")) throw new Error("provider secret and postgres URL");
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new SystemMuxEventRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.apply({
      actorId: "mux-webhook",
      correlationId: "40000000-0000-4000-8000-000000000001",
      expectedEnvironmentId: "env_staging",
      event,
    })).rejects.toThrowError(new Error("MUX_EVENT_APPLY_FAILED"));
    expect(client.query).toHaveBeenCalledWith("rollback");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe("staff Mux asset repository", () => {
  it("imports only a previously reconciled signed asset through the closed command", async () => {
    const client = {
      query: vi.fn(async (text: string) => text.includes("syntholo_content_import_mux_asset_v1")
        ? { rows: [{ id: "10000000-0000-4000-8000-000000000001", environment_id: "env_staging", provider_asset_id: "asset_123", state: "ready", signed_policy_playback_id: "playback_123", readiness_revision: 2 }] }
        : { rows: [] }),
      release: vi.fn(),
    };
    const repository = new StaffMuxAssetRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.import({
      actorId: "10000000-0000-4000-8000-000000000010",
      correlationId: "40000000-0000-4000-8000-000000000001",
      environmentId: "env_staging",
      providerAssetId: "asset_123",
    })).resolves.toMatchObject({
      mediaAssetId: "10000000-0000-4000-8000-000000000001",
      providerAssetId: "asset_123",
      signedPolicyPlaybackId: "playback_123",
    });
  });
});

describe("worker Content media repository", () => {
  it("loads and applies an authoritative reconciliation through closed worker commands", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool = { query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      queries.push({ text, values });
      if (text.includes("syntholo_content_load_mux_reconcile_target_v1")) return { rows: [{
        outcome: "current", media_asset_id: "10000000-0000-4000-8000-000000000001",
        environment_id: "env_staging", provider_asset_id: "asset_123", requested_revision: 2,
      }] };
      if (text.includes("syntholo_content_apply_mux_reconciliation_v1")) return { rows: [{ outcome: "applied" }] };
      return { rows: [] };
    }) };
    const repository = new WorkerContentMediaRepository({ pool } as never);
    await expect(repository.loadTarget({
      mediaAssetId: "10000000-0000-4000-8000-000000000001",
      requestedRevision: 2,
    })).resolves.toEqual({
      kind: "current", mediaAssetId: "10000000-0000-4000-8000-000000000001",
      environmentId: "env_staging", providerAssetId: "asset_123", requestedRevision: 2,
    });
    await expect(repository.apply({
      actorId: "mux-webhook",
      correlationId: "40000000-0000-4000-8000-000000000001",
      mediaAssetId: "10000000-0000-4000-8000-000000000001",
      expectedRevision: 2,
      snapshot: {
        environmentId: "env_staging", providerAssetId: "asset_123", state: "ready",
        signedPolicyPlaybackId: "playback_123", durationMilliseconds: 480_000,
        aspectRatio: "16:9", tracks: [{
          providerTrackId: "track_123", state: "ready", language: "en-US",
          label: "English", closedCaptions: true, source: "human",
        }],
      },
    })).resolves.toEqual({ kind: "applied" });
    expect(queries[1]?.values?.slice(0, 10)).toEqual([
      "mux-webhook", "40000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000001", 2, "env_staging", "asset_123",
      "ready", "playback_123", 480_000, "16:9",
    ]);
    expect(queries[1]?.values?.[10]).toBe(JSON.stringify([{
      providerTrackId: "track_123", state: "ready", language: "en-US",
      label: "English", closedCaptions: true, source: "human",
    }]));
  });

  it("validates and invokes the exact receipt-backed readiness command", async () => {
    const query = vi.fn(async () => ({ rows: [{ outcome: "evaluated" }] }));
    const repository = new WorkerContentMediaRepository({ pool: { query } } as never);
    await expect(repository.recompute({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "content.readiness_recompute",
    })).resolves.toEqual({ kind: "evaluated" });
    expect(query).toHaveBeenCalledWith(
      "select outcome from public.syntholo_content_recompute_readiness_event_v1($1,$2)",
      ["10000000-0000-4000-8000-000000000001", "content.readiness_recompute"],
    );
  });
});
