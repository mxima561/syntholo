import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: false, precision: 3 });
const IdSchema = z.string().uuid();

export const ResumeLessonRequestSchema = z.discriminatedUnion("path", [
  z.object({
    expectedVersion: z.number().int().min(0),
    path: z.literal("video"),
    position: z.object({ seconds: z.number().int().min(0).max(86_400) }).strict(),
  }).strict(),
  z.object({
    expectedVersion: z.number().int().min(0),
    path: z.literal("transcript"),
    position: z.object({ blockId: z.string().trim().min(1).max(128) }).strict(),
  }).strict(),
]);

export const CompleteLessonRequestSchema = z.object({
  method: z.enum(["video", "transcript", "mixed"]),
}).strict();

const LessonCompletionSchema = z.object({
  id: IdSchema,
  lessonVersionId: IdSchema,
  method: z.enum(["video", "transcript", "mixed"]),
  completedAt: TimestampSchema,
}).strict();
const CourseCompletionSchema = z.object({
  id: IdSchema,
  courseVersionId: IdSchema,
  completedAt: TimestampSchema,
}).strict();

export const CompleteLessonResponseSchema = z.object({
  schemaVersion: z.literal(1),
  lessonCompletion: LessonCompletionSchema,
  courseCompletion: CourseCompletionSchema.nullable(),
  nextRequiredLessonId: IdSchema.nullable(),
}).strict();

export type ResumeLessonRequest = z.infer<typeof ResumeLessonRequestSchema>;
export type CompleteLessonRequest = z.infer<typeof CompleteLessonRequestSchema>;
export type CompleteLessonResponse = z.infer<typeof CompleteLessonResponseSchema>;
