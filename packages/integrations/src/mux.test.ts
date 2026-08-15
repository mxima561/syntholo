import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAndParseMuxWebhook } from "./mux.js";

const secret = "test_mux_webhook_secret_which_never_leaves_the_test";
const now = new Date("2026-08-14T18:00:00.000Z");
const raw = Buffer.from(JSON.stringify({
  id: "evt_123",
  type: "video.asset.ready",
  object: { type: "asset", id: "asset_123" },
  environment: { id: "env_staging" },
  created_at: "2026-08-14T17:59:30.000Z",
  data: {
    id: "asset_123",
    status: "ready",
    duration: 480.125,
    aspect_ratio: "16:9",
    playback_ids: [{ id: "playback_123", policy: "signed" }],
  },
}));

function signature(timestamp: number, body = raw, signingSecret = secret): string {
  return `t=${timestamp},v1=${createHmac("sha256", signingSecret)
    .update(`${timestamp}.`).update(body).digest("hex")}`;
}

describe("Mux raw-body webhook boundary", () => {
  it("verifies the exact received bytes and returns one strict normalized event", () => {
    const timestamp = Math.floor(now.getTime() / 1000) - 30;
    expect(verifyAndParseMuxWebhook({
      rawBody: raw,
      signature: signature(timestamp),
      secret,
      expectedEnvironmentId: "env_staging",
      now,
    })).toEqual({
      eventId: "evt_123",
      type: "video.asset.ready",
      environmentId: "env_staging",
      occurredAt: "2026-08-14T17:59:30.000Z",
      asset: {
        providerAssetId: "asset_123",
        state: "ready",
        signedPolicyPlaybackId: "playback_123",
        durationMilliseconds: 480_125,
        aspectRatio: "16:9",
      },
      track: null,
    });
  });

  it.each([
    ["mutated body", Buffer.from(`${raw.toString("utf8")} `), signature(Math.floor(now.getTime() / 1000) - 30)],
    ["stale timestamp", raw, signature(Math.floor(now.getTime() / 1000) - 301)],
    ["wrong secret", raw, signature(Math.floor(now.getTime() / 1000) - 30, raw, "wrong")],
  ])("rejects a %s without exposing verification details", (_label, body, header) => {
    expect(() => verifyAndParseMuxWebhook({
      rawBody: body,
      signature: header,
      secret,
      expectedEnvironmentId: "env_staging",
      now,
    })).toThrowError(new Error("MUX_WEBHOOK_SIGNATURE_INVALID"));
  });

  it.each([
    ["wrong object type", { type: "live_stream", id: "asset_realistic" }],
    ["mismatched object id", { type: "asset", id: "asset_other" }],
  ])("rejects a signed known event with %s", (_label, object) => {
    const malformed = Buffer.from(JSON.stringify({
      id: "evt_malformed",
      type: "video.asset.ready",
      object,
      environment: { id: "env_staging", name: "Staging" },
      created_at: "2026-08-14T17:59:30.000000Z",
      data: { id: "asset_realistic", status: "ready", playback_ids: [{ id: "playback_realistic", policy: "signed" }] },
    }));
    const timestamp = Math.floor(now.getTime() / 1_000) - 30;
    expect(() => verifyAndParseMuxWebhook({
      rawBody: malformed,
      signature: signature(timestamp, malformed),
      secret,
      expectedEnvironmentId: "env_staging",
      now,
    })).toThrow("MUX_WEBHOOK_EVENT_INVALID");
  });

  it("rejects the wrong environment and a public-only playback ID", () => {
    const timestamp = Math.floor(now.getTime() / 1000) - 30;
    expect(() => verifyAndParseMuxWebhook({
      rawBody: raw,
      signature: signature(timestamp),
      secret,
      expectedEnvironmentId: "env_production",
      now,
    })).toThrowError(new Error("MUX_WEBHOOK_EVENT_INVALID"));

    const publicRaw = Buffer.from(raw.toString("utf8").replace('"policy":"signed"', '"policy":"public"'));
    expect(() => verifyAndParseMuxWebhook({
      rawBody: publicRaw,
      signature: signature(timestamp, publicRaw),
      secret,
      expectedEnvironmentId: "env_staging",
      now,
    })).toThrowError(new Error("MUX_WEBHOOK_EVENT_INVALID"));
  });

  it("normalizes an unknown valid event type for receipt-only acknowledgement", () => {
    const unknownRaw = Buffer.from(raw.toString("utf8")
      .replace("video.asset.ready", "video.asset.static_rendition.ready"));
    const timestamp = Math.floor(now.getTime() / 1_000) - 30;
    expect(verifyAndParseMuxWebhook({
      rawBody: unknownRaw,
      signature: signature(timestamp, unknownRaw),
      secret,
      expectedEnvironmentId: "env_staging",
      now,
    })).toMatchObject({
      eventId: "evt_123",
      type: "video.asset.static_rendition.ready",
      asset: { providerAssetId: null, state: null },
      track: null,
    });
  });

  it("accepts a realistic provider envelope with documented extra fields and microsecond time", () => {
    const realistic = Buffer.from(JSON.stringify({
      id: "evt_realistic",
      type: "video.asset.ready",
      object: { type: "asset", id: "asset_realistic" },
      environment: { id: "env_staging", name: "Staging" },
      created_at: "2026-08-14T17:59:30.123456Z",
      request_id: null,
      data: {
        id: "asset_realistic",
        status: "ready",
        duration: 480.125,
        aspect_ratio: "16:9",
        playback_ids: [{ id: "playback_realistic", policy: "signed" }],
        max_stored_resolution: "HD",
        passthrough: "provider-owned-extra",
      },
    }));
    const timestamp = Math.floor(now.getTime() / 1_000) - 30;
    expect(verifyAndParseMuxWebhook({
      rawBody: realistic,
      signature: signature(timestamp, realistic),
      secret,
      expectedEnvironmentId: "env_staging",
      now,
    })).toMatchObject({
      eventId: "evt_realistic",
      occurredAt: "2026-08-14T17:59:30.123Z",
      asset: { providerAssetId: "asset_realistic" },
    });
  });

  it("accepts an unknown valid envelope without assuming asset-shaped data", () => {
    const unknown = Buffer.from(JSON.stringify({
      id: "evt_unknown_shape",
      type: "video.live_stream.connected",
      object: { type: "live_stream", id: "live_123" },
      environment: { id: "env_staging", name: "Staging" },
      created_at: "2026-08-14T17:59:30.000000Z",
      data: { live_stream_id: "live_123", reconnect_window: 60 },
    }));
    const timestamp = Math.floor(now.getTime() / 1_000) - 30;
    expect(verifyAndParseMuxWebhook({
      rawBody: unknown,
      signature: signature(timestamp, unknown),
      secret,
      expectedEnvironmentId: "env_staging",
      now,
    })).toMatchObject({
      eventId: "evt_unknown_shape",
      type: "video.live_stream.connected",
      asset: { providerAssetId: null },
      track: null,
    });
  });

  it.each([
    ["video.asset.track.ready", "ready", "generated_live_final", "mux_generated"],
    ["video.asset.track.errored", "errored", "uploaded", "human"],
  ] as const)("maps a flat official %s payload to its owning asset", (type, state, textSource, source) => {
    const trackRaw = Buffer.from(JSON.stringify({
      id: `evt_${state}`,
      type,
      object: { type: "asset", id: "asset_123" },
      environment: { id: "env_staging", name: "Staging" },
      created_at: "2026-08-14T17:59:30.000000Z",
      attempts: [],
      data: {
        id: "track_123",
        asset_id: "asset_123",
        type: "text",
        language_code: "en-US",
        name: "English (US)",
        closed_captions: true,
        text_source: textSource,
        status: state,
        provider_extra: "ignored",
      },
    }));
    const timestamp = Math.floor(now.getTime() / 1_000) - 30;
    expect(verifyAndParseMuxWebhook({
      rawBody: trackRaw,
      signature: signature(timestamp, trackRaw),
      secret,
      expectedEnvironmentId: "env_staging",
      now,
    })).toMatchObject({
      asset: { providerAssetId: "asset_123" },
      track: { providerTrackId: "track_123", state, source },
    });
  });
});
