import { z } from "zod";
import { LessonBlocksSchema, ReleaseRuleSchema, TranscriptSchema } from "./blocks.js";

const SlugSchema = z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const TitleSchema = z.string().trim().min(1).max(255);
const DescriptionSchema = z.string().trim().min(1).max(10_000);
const ReasonSchema = z.string().trim().min(1).max(1_000);
const VersionSchema = z.number().int().positive();

export const CreateCourseRequestSchema = z.object({
  slug: SlugSchema, title: TitleSchema, description: DescriptionSchema,
}).strict();

export const CreateStageRequestSchema = z.object({
  slug: SlugSchema, title: TitleSchema, description: DescriptionSchema,
  order: z.number().int().min(1).max(1_000),
}).strict();

export const CreateLessonRequestSchema = z.object({
  slug: SlugSchema, title: TitleSchema, order: z.number().int().min(1).max(1_000),
  required: z.boolean(), releaseRule: ReleaseRuleSchema,
}).strict();

export const UpdateLessonRequestSchema = z.object({
  expectedVersion: VersionSchema,
  title: TitleSchema.optional(), summary: z.string().trim().min(1).max(10_000).optional(),
  durationSeconds: z.number().int().min(1).max(86_400).nullable().optional(),
  blocks: LessonBlocksSchema.optional(), transcript: TranscriptSchema.optional(),
  mediaAssetId: z.string().uuid().nullable().optional(),
  order: z.number().int().min(1).max(1_000).optional(), required: z.boolean().optional(),
  releaseRule: ReleaseRuleSchema.optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), {
  message: "At least one edit is required",
});

export const CreatePreviewRequestSchema = z.object({
  expectedVersion: VersionSchema, reason: ReasonSchema,
}).strict();

export const GetCoursePreviewQuerySchema = z.object({
  draftRevision: z.coerce.number().int().positive().optional(),
}).strict();

export const PublishLessonRequestSchema = z.object({
  expectedVersion: VersionSchema, reason: ReasonSchema,
}).strict();

export const PublishCourseRequestSchema = z.object({
  previewId: z.string().uuid(), expectedManifestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  expectedHeadRevision: z.number().int().min(0), reason: ReasonSchema,
}).strict();

export const PublicationIssueCodeSchema = z.enum([
  "TITLE_REQUIRED", "SUMMARY_REQUIRED", "DURATION_OUT_OF_RANGE",
  "VIDEO_NOT_READY", "SIGNED_PLAYBACK_REQUIRED", "CAPTIONS_REQUIRED",
  "TRANSCRIPT_REQUIRED", "ACTION_REQUIRED", "RESOURCE_REQUIRED",
  "ACCESSIBILITY_REVIEW_REQUIRED", "DISCLOSURE_DECISION_REQUIRED",
  "PLACEHOLDER_CONTENT",
]);

export const ContentPublicationIssueSchema = z.object({
  code: PublicationIssueCodeSchema, field: z.string().min(1).max(128),
  lessonId: z.string().uuid().nullable(),
}).strict();
export const ContentPublicationIssuesSchema = ContentPublicationIssueSchema.array().max(1_000);

export const DerivedCoursePreviewResponseSchema = z.object({
  draftRevision: VersionSchema,
  candidateManifestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  manifest: z.record(z.string(), z.unknown()),
  publicationIssues: ContentPublicationIssuesSchema,
}).strict();

export const PublicationIssueSchema = ContentPublicationIssueSchema;
export type ContentPublicationIssue = z.infer<typeof ContentPublicationIssueSchema>;
export type PublicationIssue = ContentPublicationIssue;

export const ContentPublicationConflictCodeSchema = z.enum([
  "CONTENT_NOT_READY", "MANIFEST_CHANGED", "COURSE_HEAD_CHANGED", "PREVIEW_ALREADY_PUBLISHED",
  "IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_IN_PROGRESS", "VERSION_CONFLICT",
  "LESSON_DRAFT_ALREADY_PUBLISHED",
]);
export type ContentPublicationConflictCode = z.infer<typeof ContentPublicationConflictCodeSchema>;
