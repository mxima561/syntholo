import { describe, expect, it } from "vitest";
import {
  CompleteLessonRequestSchema,
  CompleteLessonResponseSchema,
  ResumeLessonRequestSchema,
} from "./progress.js";

describe("member learning progress contracts", () => {
  it("accepts only path-matched resume positions without caller authority", () => {
    expect(ResumeLessonRequestSchema.parse({
      expectedVersion: 2, path: "video", position: { seconds: 123 },
    })).toEqual({ expectedVersion: 2, path: "video", position: { seconds: 123 } });
    expect(ResumeLessonRequestSchema.safeParse({
      expectedVersion: 2, path: "transcript", position: { seconds: 123 },
    }).success).toBe(false);
    expect(ResumeLessonRequestSchema.safeParse({
      expectedVersion: 2, path: "video", position: { seconds: 123 }, membershipId: crypto.randomUUID(),
    }).success).toBe(false);
  });

  it("treats transcript completion as equal and keeps the immutable result exact", () => {
    expect(CompleteLessonRequestSchema.parse({ method: "transcript" }))
      .toEqual({ method: "transcript" });
    const response = {
      schemaVersion: 1,
      lessonCompletion: {
        id: "10000000-0000-4000-8000-000000000001",
        lessonVersionId: "10000000-0000-4000-8000-000000000002",
        method: "transcript",
        completedAt: "2026-08-15T12:00:00.000Z",
      },
      courseCompletion: null,
      nextRequiredLessonId: null,
    } as const;
    expect(CompleteLessonResponseSchema.parse(response)).toEqual(response);
    expect(CompleteLessonResponseSchema.safeParse({ ...response, certificateId: "public-id" }).success)
      .toBe(false);
  });
});
