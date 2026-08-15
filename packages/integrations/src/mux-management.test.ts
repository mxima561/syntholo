import { describe, expect, it, vi } from "vitest";
import { createMuxAssetManagementClient } from "./mux.js";

describe("Mux asset management client", () => {
  it("retrieves and normalizes authoritative asset and caption state", async () => {
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => {
      void _input;
      void _init;
      return new Response(JSON.stringify({ data: {
      id: "asset_123",
      status: "ready",
      duration: 480.125,
      aspect_ratio: "16:9",
      playback_ids: [{ id: "playback_123", policy: "signed" }],
      tracks: [{
        id: "track_123", type: "text", status: "ready", language_code: "en-US",
        name: "English (US)", closed_captions: true, text_source: "generated_live",
      }],
      provider_extra: true,
      } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = createMuxAssetManagementClient({
      tokenId: "mux-token-id",
      tokenSecret: "mux-token-secret-value",
      environmentId: "env_staging",
      fetch,
    });
    await expect(client.retrieveAsset("asset_123", new AbortController().signal))
      .resolves.toEqual({
        environmentId: "env_staging",
        providerAssetId: "asset_123",
        state: "ready",
        signedPolicyPlaybackId: "playback_123",
        durationMilliseconds: 480_125,
        aspectRatio: "16:9",
        tracks: [{
          providerTrackId: "track_123", state: "ready", language: "en-US",
          label: "English (US)", closedCaptions: true, source: "mux_generated",
        }],
      });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.mux.com/video/v1/assets/asset_123",
      expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) }),
    );
    const headers = fetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toMatch(/^Basic /u);
  });

  it("normalizes provider failures without leaking credentials or response bodies", async () => {
    const client = createMuxAssetManagementClient({
      tokenId: "mux-token-id",
      tokenSecret: "mux-token-secret-value",
      environmentId: "env_staging",
      fetch: vi.fn(async () => new Response("private provider body", { status: 503 })),
    });
    await expect(client.retrieveAsset("asset_123", new AbortController().signal))
      .rejects.toMatchObject({ message: "MUX_MANAGEMENT_UNAVAILABLE", terminal: false });
  });

  it.each([
    [404, "MUX_MANAGEMENT_OBJECT_TERMINAL"],
    [410, "MUX_MANAGEMENT_OBJECT_TERMINAL"],
    [401, "MUX_MANAGEMENT_AUTH_TERMINAL"],
    [403, "MUX_MANAGEMENT_AUTH_TERMINAL"],
  ])("preserves safe terminal classification for HTTP %s", async (status, code) => {
    const client = createMuxAssetManagementClient({
      tokenId: "mux-token-id",
      tokenSecret: "mux-token-secret-value",
      environmentId: "env_staging",
      fetch: vi.fn(async () => new Response("private provider body", { status })),
    });
    await expect(client.retrieveAsset("asset_123", new AbortController().signal))
      .rejects.toMatchObject({ message: code, terminal: true });
  });
});
