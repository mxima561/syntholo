const assetStates = new Set(["waiting", "preparing", "ready", "errored", "deleted"]);

export type MuxMediaMutation = Readonly<{
  objectKind: "asset" | "track";
  state: "waiting" | "preparing" | "ready" | "errored" | "deleted";
}>;

export function mapMuxEventToMediaMutation(input: Readonly<{
  type: string;
  providerState: string | null;
}>): MuxMediaMutation {
  const direct: Readonly<Record<string, MuxMediaMutation>> = {
    "video.asset.created": { objectKind: "asset", state: "waiting" },
    "video.asset.ready": { objectKind: "asset", state: "ready" },
    "video.asset.errored": { objectKind: "asset", state: "errored" },
    "video.asset.deleted": { objectKind: "asset", state: "deleted" },
    "video.asset.track.created": { objectKind: "track", state: "preparing" },
    "video.asset.track.ready": { objectKind: "track", state: "ready" },
    "video.asset.track.errored": { objectKind: "track", state: "errored" },
    "video.asset.track.deleted": { objectKind: "track", state: "deleted" },
  };
  if (input.type === "video.asset.updated") {
    if (input.providerState !== null && assetStates.has(input.providerState)) {
      return Object.freeze({ objectKind: "asset", state: input.providerState }) as MuxMediaMutation;
    }
    if (input.providerState === null) {
      return Object.freeze({ objectKind: "asset", state: "preparing" });
    }
  }
  const mapped = direct[input.type];
  if (mapped === undefined) throw new Error("MUX_EVENT_INVALID");
  return Object.freeze({ ...mapped });
}
