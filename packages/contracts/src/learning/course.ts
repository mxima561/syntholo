import { z } from "zod";
import { LessonBlocksSchema, ReleaseRuleSchema, TranscriptSchema } from "../content/blocks";

const IdSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: false, precision: 3 });

export const ResourceSummarySchema = z.object({
  id: IdSchema,
  label: z.string().trim().min(1).max(255),
  accessibleLabel: z.string().trim().min(1).max(255),
  delivery: z.enum(["external_https", "private_blob"]),
  mime: z.string().trim().min(3).max(255),
  byteSize: z.number().int().min(0).max(26_214_400),
  availability: z.enum(["preparing", "ready", "unavailable", "deleted"]),
}).strict();

const CourseLessonSummarySchema = z.object({
  id: IdSchema,
  lessonVersionId: IdSchema,
  order: z.number().int().positive(),
  required: z.boolean(),
  title: z.string().trim().min(1).max(255),
  summary: z.string().trim().min(1).max(10_000),
  durationSeconds: z.number().int().min(300).max(720),
  releaseRule: ReleaseRuleSchema,
  availability: z.enum(["available", "locked"]),
  availableAt: TimestampSchema,
  progress: z.enum(["not_started", "in_progress", "completed"]),
}).strict();

export const MemberCourseResponseSchema = z.object({
  schemaVersion: z.literal(1),
  enrollmentId: IdSchema,
  course: z.object({
    id: IdSchema,
    versionId: IdSchema,
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().min(1).max(10_000),
  }).strict(),
  stages: z.array(z.object({
    id: IdSchema,
    title: z.string().trim().min(1).max(255),
    order: z.number().int().positive(),
    lessons: z.array(CourseLessonSummarySchema).max(1_000),
  }).strict()).max(100),
  progress: z.object({
    completedRequired: z.number().int().min(0).max(18),
    requiredTotal: z.literal(18),
    percent: z.number().int().min(0).max(100),
  }).strict(),
}).strict();

const NotStartedProgressSchema = z.object({
  revision: z.null(), state: z.literal("not_started"), lastPath: z.null(), position: z.null(),
}).strict();
const VideoProgressSchema = z.object({
  revision: z.number().int().positive(),
  state: z.enum(["in_progress", "completed"]),
  lastPath: z.literal("video"),
  position: z.object({ seconds: z.number().int().min(0).max(86_400) }).strict(),
}).strict();
const TranscriptProgressSchema = z.object({
  revision: z.number().int().positive(),
  state: z.enum(["in_progress", "completed"]),
  lastPath: z.literal("transcript"),
  position: z.object({ blockId: z.string().trim().min(1).max(128) }).strict(),
}).strict();
const CompletedWithoutResumeSchema = z.object({
  revision: z.null(), state: z.literal("completed"), lastPath: z.null(), position: z.null(),
}).strict();

export const MemberLessonProgressSchema = z.union([
  NotStartedProgressSchema,
  VideoProgressSchema,
  TranscriptProgressSchema,
  CompletedWithoutResumeSchema,
]);

export const MemberLessonResponseSchema = z.object({
  schemaVersion: z.literal(1),
  enrollmentId: IdSchema,
  courseVersionId: IdSchema,
  lessonId: IdSchema,
  lessonVersionId: IdSchema,
  title: z.string().trim().min(1).max(255),
  summary: z.string().trim().min(1).max(10_000),
  durationSeconds: z.number().int().min(300).max(720),
  blocks: LessonBlocksSchema,
  transcript: TranscriptSchema,
  resources: z.array(ResourceSummarySchema).max(100),
  progress: MemberLessonProgressSchema,
  previousRequiredLessonId: IdSchema.nullable(),
  nextRequiredLessonId: IdSchema.nullable(),
}).strict();

const ReadyPlaybackSchema = z.object({
  schemaVersion: z.literal(1),
  lessonVersionId: IdSchema,
  playbackStatus: z.literal("ready"),
  mux: z.object({
    playbackId: z.string().trim().min(1).max(255),
    playbackToken: z.string().trim().min(1).max(8_192),
    thumbnailToken: z.string().trim().min(1).max(8_192).optional(),
    storyboardToken: z.string().trim().min(1).max(8_192).optional(),
    issuedAt: TimestampSchema,
    refreshAfter: TimestampSchema,
    expiresAt: TimestampSchema,
  }).strict(),
}).strict();
const DegradedPlaybackSchema = z.object({
  schemaVersion: z.literal(1),
  lessonVersionId: IdSchema,
  playbackStatus: z.literal("degraded"),
  reason: z.enum(["MUX_UNAVAILABLE", "MEDIA_NOT_READY", "MEDIA_ERRORED", "MEDIA_DELETED"]),
  fallback: z.object({
    title: z.string().trim().min(1).max(255),
    summary: z.string().trim().min(1).max(10_000),
    blocks: LessonBlocksSchema,
    transcript: TranscriptSchema,
    resources: z.array(ResourceSummarySchema).max(100),
  }).strict(),
}).strict();

export const LessonPlaybackResponseSchema = z.discriminatedUnion("playbackStatus", [
  ReadyPlaybackSchema,
  DegradedPlaybackSchema,
]);

export type MemberCourseResponse = z.infer<typeof MemberCourseResponseSchema>;
export type MemberLessonResponse = z.infer<typeof MemberLessonResponseSchema>;
export type MemberLessonProgress = z.infer<typeof MemberLessonProgressSchema>;
export type LessonPlaybackResponse = z.infer<typeof LessonPlaybackResponseSchema>;
