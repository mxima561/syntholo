import { describe, expect, it } from "vitest";
import {
  ContentMediaAssetSchema,
  ContentMediaTrackSchema,
  MuxWebhookEventSchema,
} from "./media.js";

describe("content media contracts", () => {
  it("accepts only a signed Mux asset projection without provider payload fields", () => {
    const asset = ContentMediaAssetSchema.parse({
      id: "10000000-0000-4000-8000-000000000001",
      provider: "mux",
      environmentId: "env_staging",
      providerAssetId: "asset_123",
      signedPolicyPlaybackId: "playback_123",
      state: "ready",
      durationMilliseconds: 480_000,
      aspectRatio: "16:9",
      readinessRevision: 3,
      lastProviderEventAt: "2026-08-14T18:00:00.000Z",
      lastProviderEventId: "evt_123",
      lastReconciledAt: null,
    });

    expect(asset.state).toBe("ready");
    expect(() => ContentMediaAssetSchema.parse({ ...asset, playbackPolicy: "public" }))
      .toThrow();
  });

  it("rejects a non-caption track and malformed BCP-47 language", () => {
    const valid = {
      id: "10000000-0000-4000-8000-000000000002",
      mediaAssetId: "10000000-0000-4000-8000-000000000001",
      providerTrackId: "track_123",
      kind: "captions",
      language: "en-US",
      label: "English (US)",
      closedCaptions: true,
      source: "human",
      state: "ready",
      readinessRevision: 1,
      lastProviderEventAt: "2026-08-14T18:00:00.000Z",
      lastProviderEventId: "evt_track_123",
    };
    expect(ContentMediaTrackSchema.parse(valid).language).toBe("en-US");
    expect(() => ContentMediaTrackSchema.parse({ ...valid, kind: "audio" })).toThrow();
    expect(() => ContentMediaTrackSchema.parse({ ...valid, language: "English" })).toThrow();
  });

  it("accepts the exact allowlisted normalized Mux event and rejects unknown fields", () => {
    const event = MuxWebhookEventSchema.parse({
      eventId: "evt_123",
      type: "video.asset.track.ready",
      environmentId: "env_staging",
      occurredAt: "2026-08-14T18:00:00.000Z",
      asset: {
        providerAssetId: "asset_123",
        state: null,
        signedPolicyPlaybackId: null,
        durationMilliseconds: null,
        aspectRatio: null,
      },
      track: {
        providerTrackId: "track_123",
        state: "ready",
        language: "en",
        label: "English",
        closedCaptions: true,
        source: "human",
      },
    });
    expect(event.type).toBe("video.asset.track.ready");
    expect(() => MuxWebhookEventSchema.parse({ ...event, rawPayload: { private: true } }))
      .toThrow();
  });
});
