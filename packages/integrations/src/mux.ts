import { createHmac, timingSafeEqual } from "node:crypto";
import {
  MuxWebhookEventSchema,
  MuxWebhookEventTypeSchema,
  type MuxWebhookEvent,
} from "@syntholo/contracts/content";
import { mapMuxEventToMediaMutation } from "@syntholo/domain/content";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

type ProviderEvent = Readonly<{
  id?: unknown;
  type?: unknown;
  environment?: unknown;
  created_at?: unknown;
  data?: unknown;
  object?: unknown;
}>;

function failSignature(): never {
  throw new Error("MUX_WEBHOOK_SIGNATURE_INVALID");
}

function failEvent(): never {
  throw new Error("MUX_WEBHOOK_EVENT_INVALID");
}

function parseSignature(header: string): Readonly<{ timestamp: number; signatures: readonly string[] }> {
  const values = header.split(",").map((value) => value.trim().split("=", 2));
  const timestampText = values.find(([key]) => key === "t")?.[1];
  const signatures = values.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  if (timestampText === undefined || !/^[0-9]{1,12}$/u.test(timestampText) || signatures.length === 0) {
    return failSignature();
  }
  return { timestamp: Number(timestampText), signatures };
}

function providerObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function string(value: unknown): string {
  return typeof value === "string" && identifier.test(value) ? value : failEvent();
}

function timestamp(value: unknown): string {
  if (typeof value !== "string"
    || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u.test(value)) return failEvent();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return failEvent();
  return parsed.toISOString();
}

function trackSource(value: unknown): "human" | "mux_generated" {
  if (value === "generated_vod" || value === "generated_live" || value === "generated_live_final") {
    return "mux_generated";
  }
  if (value === "uploaded" || value === "embedded") return "human";
  return failEvent();
}

function parseAsset(data: Record<string, unknown>, type: string, known: boolean) {
  if (!known) return {
    providerAssetId: null,
    state: null,
    signedPolicyPlaybackId: null,
    durationMilliseconds: null,
    aspectRatio: null,
  };
  const providerAssetId = string(type.startsWith("video.asset.track.")
    ? data.asset_id
    : data.id);
  const providerState = typeof data.status === "string" ? data.status : null;
  const mutation = mapMuxEventToMediaMutation({ type, providerState });
  const playbackIds = data.playback_ids;
  let signedPolicyPlaybackId: string | null = null;
  if (playbackIds !== undefined) {
    if (!Array.isArray(playbackIds)) return failEvent();
    const signed = playbackIds.filter((item) => providerObject(item) && item.policy === "signed");
    const nonSigned = playbackIds.filter((item) => providerObject(item) && item.policy !== "signed");
    if (signed.length > 1 || (signed.length === 0 && nonSigned.length > 0)) return failEvent();
    if (signed[0] !== undefined) signedPolicyPlaybackId = string(signed[0].id);
  }
  const duration = data.duration;
  const durationMilliseconds = duration === undefined || duration === null
    ? null
    : typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? Math.round(duration * 1_000)
      : failEvent();
  const aspectRatio = data.aspect_ratio === undefined || data.aspect_ratio === null
    ? null
    : typeof data.aspect_ratio === "string" ? data.aspect_ratio : failEvent();
  return {
    providerAssetId,
    state: mutation.objectKind === "asset" ? mutation.state : null,
    signedPolicyPlaybackId,
    durationMilliseconds,
    aspectRatio,
  };
}

function parseTrack(data: Record<string, unknown>, type: string) {
  const mutation = mapMuxEventToMediaMutation({ type, providerState: null });
  if (data.type !== "text" || mutation.objectKind !== "track") return failEvent();
  return {
    providerTrackId: string(data.id),
    state: mutation.state,
    language: string(data.language_code),
    label: typeof data.name === "string" ? data.name : failEvent(),
    closedCaptions: data.closed_captions === true,
    source: trackSource(data.text_source),
  };
}

export function verifyAndParseMuxWebhook(input: Readonly<{
  rawBody: Buffer;
  signature: string;
  secret: string;
  expectedEnvironmentId: string;
  now: Date;
  toleranceSeconds?: number;
}>): MuxWebhookEvent {
  try {
    if (!Buffer.isBuffer(input.rawBody) || input.rawBody.byteLength === 0 || input.rawBody.byteLength > 1_048_576) {
      return failSignature();
    }
    if (input.secret.length < 16 || !identifier.test(input.expectedEnvironmentId) || !Number.isFinite(input.now.getTime())) {
      return failSignature();
    }
    const parsedSignature = parseSignature(input.signature);
    const tolerance = input.toleranceSeconds ?? 300;
    const nowSeconds = Math.floor(input.now.getTime() / 1_000);
    if (!Number.isInteger(tolerance) || tolerance < 1 || tolerance > 300
      || Math.abs(nowSeconds - parsedSignature.timestamp) > tolerance) return failSignature();
    const expected = createHmac("sha256", input.secret)
      .update(`${parsedSignature.timestamp}.`).update(input.rawBody).digest();
    const verified = parsedSignature.signatures.some((candidate) => {
      if (!/^[0-9a-f]{64}$/u.test(candidate)) return false;
      const actual = Buffer.from(candidate, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
    if (!verified) return failSignature();
  } catch (error) {
    if (error instanceof Error && error.message === "MUX_WEBHOOK_SIGNATURE_INVALID") throw error;
    return failSignature();
  }

  try {
    const provider = JSON.parse(input.rawBody.toString("utf8")) as ProviderEvent;
    if (!providerObject(provider)
      || !providerObject(provider.environment)
      || !providerObject(provider.data)
      || !providerObject(provider.object)) {
      return failEvent();
    }
    const eventId = string(provider.id);
    const type = string(provider.type);
    const known = MuxWebhookEventTypeSchema.safeParse(type).success;
    const environmentId = string(provider.environment.id);
    if (environmentId !== input.expectedEnvironmentId) return failEvent();
    const data = provider.data;
    const asset = parseAsset(data, type, known);
    if (known && (provider.object.type !== "asset"
      || string(provider.object.id) !== asset.providerAssetId)) return failEvent();
    return MuxWebhookEventSchema.parse({
      eventId,
      type,
      environmentId,
      occurredAt: timestamp(provider.created_at),
      asset,
      track: known && type.startsWith("video.asset.track.") ? parseTrack(data, type) : null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "MUX_WEBHOOK_EVENT_INVALID") throw error;
    return failEvent();
  }
}

export type MuxAssetManagementPort = Readonly<{
  retrieveAsset(providerAssetId: string, signal: AbortSignal): Promise<MuxWebhookEvent["asset"] & Readonly<{
    environmentId: string;
    tracks: readonly NonNullable<MuxWebhookEvent["track"]>[];
  }>>;
}>;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class MuxManagementError extends Error {
  readonly terminal: boolean;

  constructor(code: "MUX_MANAGEMENT_UNAVAILABLE" | "MUX_MANAGEMENT_OBJECT_TERMINAL" | "MUX_MANAGEMENT_AUTH_TERMINAL", terminal: boolean) {
    super(code);
    this.terminal = terminal;
  }
}

function failManagement(): never {
  throw new MuxManagementError("MUX_MANAGEMENT_UNAVAILABLE", false);
}

function parseManagementTrack(value: unknown): NonNullable<MuxWebhookEvent["track"]> | null {
  if (!providerObject(value) || value.type !== "text") return null;
  const state = value.status;
  if (state !== "preparing" && state !== "ready" && state !== "errored" && state !== "deleted") {
    return failManagement();
  }
  try {
    return {
      providerTrackId: string(value.id),
      state,
      language: string(value.language_code),
      label: typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 100
        ? value.name
        : failManagement(),
      closedCaptions: value.closed_captions === true,
      source: trackSource(value.text_source),
    };
  } catch {
    return failManagement();
  }
}

export function createMuxAssetManagementClient(input: Readonly<{
  tokenId: string;
  tokenSecret: string;
  environmentId: string;
  fetch?: Fetch;
}>): MuxAssetManagementPort {
  if (!identifier.test(input.tokenId) || input.tokenSecret.length < 16
    || !identifier.test(input.environmentId)) return failManagement();
  const request = input.fetch ?? globalThis.fetch;
  const authorization = `Basic ${Buffer.from(`${input.tokenId}:${input.tokenSecret}`, "utf8").toString("base64")}`;

  return Object.freeze({
    async retrieveAsset(providerAssetId: string, signal: AbortSignal) {
      if (!identifier.test(providerAssetId) || !(signal instanceof AbortSignal)) return failManagement();
      let response: Response;
      try {
        response = await request(
          `https://api.mux.com/video/v1/assets/${encodeURIComponent(providerAssetId)}`,
          {
            method: "GET",
            redirect: "error",
            signal,
            headers: new Headers({ accept: "application/json", authorization }),
          },
        );
      } catch {
        return failManagement();
      }
      if (response.status === 404 || response.status === 410) {
        throw new MuxManagementError("MUX_MANAGEMENT_OBJECT_TERMINAL", true);
      }
      if (response.status === 401 || response.status === 403) {
        throw new MuxManagementError("MUX_MANAGEMENT_AUTH_TERMINAL", true);
      }
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        return failManagement();
      }
      try {
        const envelope = await response.json() as unknown;
        if (!providerObject(envelope) || !providerObject(envelope.data)) return failManagement();
        const data = envelope.data;
        if (string(data.id) !== providerAssetId) return failManagement();
        const state = data.status;
        if (state !== "waiting" && state !== "preparing" && state !== "ready"
          && state !== "errored" && state !== "deleted") return failManagement();
        const playbackIds = data.playback_ids;
        let signedPolicyPlaybackId: string | null = null;
        if (playbackIds !== undefined && playbackIds !== null) {
          if (!Array.isArray(playbackIds)) return failManagement();
          const signed = playbackIds.filter((item) => providerObject(item) && item.policy === "signed");
          const publicPlayback = playbackIds.some((item) => providerObject(item) && item.policy === "public");
          if (signed.length > 1 || (signed.length === 0 && publicPlayback)) return failManagement();
          if (signed[0] !== undefined) signedPolicyPlaybackId = string(signed[0].id);
        }
        const duration = data.duration;
        const durationMilliseconds = duration === undefined || duration === null
          ? null
          : typeof duration === "number" && Number.isFinite(duration) && duration > 0
            ? Math.round(duration * 1_000)
            : failManagement();
        const aspectRatio = data.aspect_ratio === undefined || data.aspect_ratio === null
          ? null
          : typeof data.aspect_ratio === "string" && /^[1-9][0-9]{0,4}:[1-9][0-9]{0,4}$/u.test(data.aspect_ratio)
            ? data.aspect_ratio
            : failManagement();
        if (data.tracks !== undefined && !Array.isArray(data.tracks)) return failManagement();
        const tracks = (data.tracks ?? []).map(parseManagementTrack)
          .filter((track): track is NonNullable<typeof track> => track !== null);
        return {
          environmentId: input.environmentId,
          providerAssetId,
          state,
          signedPolicyPlaybackId,
          durationMilliseconds,
          aspectRatio,
          tracks,
        };
      } catch (error) {
        if (error instanceof Error && error.message === "MUX_MANAGEMENT_UNAVAILABLE") throw error;
        return failManagement();
      }
    },
  });
}
