import { z } from "zod";

const identifier = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const canonicalTimestamp = z.iso.datetime({ offset: false, precision: 3 });
const language = z.string().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u);

export const ContentMediaStateSchema = z.enum([
  "waiting",
  "preparing",
  "ready",
  "errored",
  "deleted",
]);

export const ContentMediaTrackStateSchema = z.enum([
  "preparing",
  "ready",
  "errored",
  "deleted",
]);

export const ContentMediaAssetSchema = z.strictObject({
  id: z.uuid(),
  provider: z.literal("mux"),
  environmentId: identifier,
  providerAssetId: identifier,
  signedPolicyPlaybackId: identifier.nullable(),
  state: ContentMediaStateSchema,
  durationMilliseconds: z.number().int().positive().max(86_400_000).nullable(),
  aspectRatio: z.string().regex(/^[1-9][0-9]{0,4}:[1-9][0-9]{0,4}$/u).nullable(),
  readinessRevision: z.number().int().nonnegative(),
  lastProviderEventAt: canonicalTimestamp.nullable(),
  lastProviderEventId: identifier.nullable(),
  lastReconciledAt: canonicalTimestamp.nullable(),
});

export const ContentMediaTrackSchema = z.strictObject({
  id: z.uuid(),
  mediaAssetId: z.uuid(),
  providerTrackId: identifier,
  kind: z.literal("captions"),
  language,
  label: z.string().trim().min(1).max(100),
  closedCaptions: z.boolean(),
  source: z.enum(["human", "mux_generated"]),
  state: ContentMediaTrackStateSchema,
  readinessRevision: z.number().int().nonnegative(),
  lastProviderEventAt: canonicalTimestamp.nullable(),
  lastProviderEventId: identifier.nullable(),
});

const MuxAssetEventSchema = z.strictObject({
  providerAssetId: identifier.nullable(),
  state: ContentMediaStateSchema.nullable(),
  signedPolicyPlaybackId: identifier.nullable(),
  durationMilliseconds: z.number().int().positive().max(86_400_000).nullable(),
  aspectRatio: z.string().regex(/^[1-9][0-9]{0,4}:[1-9][0-9]{0,4}$/u).nullable(),
});

const MuxTrackEventSchema = z.strictObject({
  providerTrackId: identifier,
  state: ContentMediaTrackStateSchema,
  language,
  label: z.string().trim().min(1).max(100),
  closedCaptions: z.boolean(),
  source: z.enum(["human", "mux_generated"]),
});

export const MuxWebhookEventTypeSchema = z.enum([
  "video.asset.created",
  "video.asset.ready",
  "video.asset.errored",
  "video.asset.updated",
  "video.asset.deleted",
  "video.asset.track.created",
  "video.asset.track.ready",
  "video.asset.track.errored",
  "video.asset.track.deleted",
]);

export const MuxWebhookEventSchema = z.strictObject({
  eventId: identifier,
  type: identifier,
  environmentId: identifier,
  occurredAt: canonicalTimestamp,
  asset: MuxAssetEventSchema,
  track: MuxTrackEventSchema.nullable(),
}).superRefine((event, context) => {
  const known = MuxWebhookEventTypeSchema.safeParse(event.type);
  const isTrack = known.success && event.type.startsWith("video.asset.track.");
  if (known.success && isTrack !== (event.track !== null)) {
    context.addIssue({ code: "custom", message: "track shape does not match event type" });
  }
  if (known.success && event.asset.providerAssetId === null) {
    context.addIssue({ code: "custom", message: "known event requires asset identity" });
  }
});

export type ContentMediaAsset = z.infer<typeof ContentMediaAssetSchema>;
export type ContentMediaTrack = z.infer<typeof ContentMediaTrackSchema>;
export type MuxWebhookEvent = z.infer<typeof MuxWebhookEventSchema>;
export type MuxWebhookEventType = z.infer<typeof MuxWebhookEventTypeSchema>;
