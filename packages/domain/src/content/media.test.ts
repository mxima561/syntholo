import { describe, expect, it } from "vitest";
import { mapMuxEventToMediaMutation } from "./media.js";

describe("Mux media state mapping", () => {
  it.each([
    ["video.asset.created", "waiting"],
    ["video.asset.updated", "preparing"],
    ["video.asset.ready", "ready"],
    ["video.asset.errored", "errored"],
    ["video.asset.deleted", "deleted"],
  ] as const)("maps %s to the authoritative asset state %s", (type, state) => {
    expect(mapMuxEventToMediaMutation({ type, providerState: null })).toEqual({
      objectKind: "asset",
      state,
    });
  });

  it.each([
    ["video.asset.track.created", "preparing"],
    ["video.asset.track.ready", "ready"],
    ["video.asset.track.errored", "errored"],
    ["video.asset.track.deleted", "deleted"],
  ] as const)("maps %s to the authoritative caption state %s", (type, state) => {
    expect(mapMuxEventToMediaMutation({ type, providerState: null })).toEqual({
      objectKind: "track",
      state,
    });
  });

  it("uses only a closed provider-state mapping for asset.updated", () => {
    expect(mapMuxEventToMediaMutation({ type: "video.asset.updated", providerState: "ready" }))
      .toEqual({ objectKind: "asset", state: "ready" });
    expect(() => mapMuxEventToMediaMutation({
      type: "video.asset.updated",
      providerState: "unknown-provider-state",
    })).toThrow("MUX_EVENT_INVALID");
  });
});
