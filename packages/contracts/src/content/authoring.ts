import { z } from "zod";
import { LessonBlocksSchema, TranscriptSchema } from "./blocks";

const SlugSchema = z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const TitleSchema = z.string().trim().min(1).max(255);
const DescriptionSchema = z.string().trim().min(1).max(10_000);
const SummarySchema = z.string().trim().min(1).max(10_000);
const ReasonSchema = z.string().trim().min(1).max(1_000);
const OrderSchema = z.number().int().min(1).max(1_000);
const VersionSchema = z.number().int().positive();

export const CreateCourseDraftRequestSchema = z.object({
  slug: SlugSchema, title: TitleSchema, description: DescriptionSchema,
}).strict();

export const CourseDraftResponseSchema = z.object({
  courseId: z.string().uuid(), slug: SlugSchema, title: TitleSchema,
  description: DescriptionSchema, revision: VersionSchema,
  createdAt: z.string().datetime({ offset: false, precision: 3 }),
}).strict();

export const CourseSummarySchema = z.object({
  courseId: z.string().uuid(), slug: SlugSchema, title: TitleSchema,
  description: DescriptionSchema, revision: VersionSchema, published: z.boolean(),
  createdAt: z.string().datetime({ offset: false, precision: 3 }),
  enrolledCount: z.number().int().min(0),
}).strict();

export const CourseListResponseSchema = z.object({
  courses: z.array(CourseSummarySchema),
}).strict();

export const UpsertStageDraftRequestSchema = z.object({
  expectedCourseRevision: VersionSchema,
  slug: SlugSchema, title: TitleSchema, description: DescriptionSchema, order: OrderSchema,
}).strict();

export const StageDraftResponseSchema = z.object({
  stageId: z.string().uuid(), courseId: z.string().uuid(), slug: SlugSchema,
  title: TitleSchema, description: DescriptionSchema, order: OrderSchema, revision: VersionSchema,
}).strict();

export const UpsertLessonDraftRequestSchema = z.object({
  stageId: z.string().uuid(),
  slug: SlugSchema, title: TitleSchema, summary: SummarySchema,
  durationSeconds: z.number().int().min(300).max(720),
  blocks: LessonBlocksSchema, transcript: TranscriptSchema,
  order: OrderSchema, required: z.boolean(),
}).strict();

export const LessonDraftResponseSchema = z.object({
  lessonId: z.string().uuid(), courseId: z.string().uuid(), stageId: z.string().uuid(),
  slug: SlugSchema, revision: VersionSchema, mediaAssetId: z.string().uuid(),
  order: OrderSchema, required: z.boolean(),
}).strict();

export const RecordLessonReviewRequestSchema = z.object({
  expectedRevision: VersionSchema, reason: ReasonSchema,
}).strict();

export const LessonReviewResponseSchema = z.object({
  lessonId: z.string().uuid(), draftRevision: VersionSchema, draftHash: z.string().regex(/^[0-9a-f]{64}$/u),
  accessibilityDecisionId: z.string().uuid(), disclosureDecisionId: z.string().uuid(),
}).strict();

export const UpdateCourseDraftRequestSchema = z.object({
  expectedRevision: VersionSchema, title: TitleSchema, description: DescriptionSchema,
}).strict();

export const CourseDraftUpdateResponseSchema = z.object({
  courseId: z.string().uuid(), title: TitleSchema, description: DescriptionSchema, revision: VersionSchema,
}).strict();

const LessonDraftTreeSchema = z.object({
  lessonId: z.string().uuid(), slug: SlugSchema, title: TitleSchema, summary: SummarySchema,
  durationSeconds: z.number().int(), blocks: LessonBlocksSchema, transcript: TranscriptSchema,
  order: OrderSchema, required: z.boolean(), revision: VersionSchema,
}).strict();

const StageDraftTreeSchema = z.object({
  stageId: z.string().uuid(), slug: SlugSchema, title: TitleSchema, description: DescriptionSchema,
  order: OrderSchema, revision: VersionSchema, lessons: z.array(LessonDraftTreeSchema),
}).strict();

export const CourseDraftTreeResponseSchema = z.object({
  courseId: z.string().uuid(), slug: SlugSchema, title: TitleSchema, description: DescriptionSchema,
  revision: VersionSchema, stages: z.array(StageDraftTreeSchema),
}).strict();

export const GrantEnrollmentRequestSchema = z.object({
  accountId: z.string().uuid(), courseId: z.string().uuid(), reason: ReasonSchema,
}).strict();

export const EnrollmentGrantResponseSchema = z.object({
  enrollmentId: z.string().uuid(), accountId: z.string().uuid(), courseId: z.string().uuid(),
  courseVersionId: z.string().uuid(), enrolledAt: z.string().datetime({ offset: false, precision: 3 }),
}).strict();

export const CreateLessonUploadResponseSchema = z.object({
  uploadId: z.string().min(1).max(255), url: z.string().url(),
}).strict();

export const FinalizeLessonUploadRequestSchema = z.object({
  expectedRevision: VersionSchema,
}).strict();

export const AttachLessonMediaResponseSchema = z.object({
  lessonId: z.string().uuid(), revision: VersionSchema, mediaAssetId: z.string().uuid(),
  mediaState: z.enum(["waiting", "preparing", "ready", "errored", "deleted"]),
}).strict();

export const ContentAuthoringConflictCodeSchema = z.enum([
  "CONTENT_SLUG_TAKEN", "CONTENT_NOT_FOUND", "VERSION_CONFLICT", "CONTENT_BLOCKS_INVALID",
  "IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_IN_PROGRESS",
]);
export type ContentAuthoringConflictCode = z.infer<typeof ContentAuthoringConflictCodeSchema>;

export const LearningAdminConflictCodeSchema = z.enum([
  "LEARNING_ADMIN_MEMBERSHIP_NOT_FOUND", "LEARNING_ADMIN_COURSE_NOT_PUBLISHED",
  "LEARNING_ADMIN_ALREADY_ENROLLED", "IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_IN_PROGRESS",
]);
export type LearningAdminConflictCode = z.infer<typeof LearningAdminConflictCodeSchema>;
