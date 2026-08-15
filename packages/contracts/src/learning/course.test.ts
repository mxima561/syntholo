import { describe, expect, it } from "vitest";
import {
  MemberCourseResponseSchema,
  MemberLessonResponseSchema,
  LessonPlaybackResponseSchema,
} from "./course.js";

const course = {
  schemaVersion: 1,
  enrollmentId: "10000000-0000-4000-8000-000000000001",
  course: {
    id: "10000000-0000-4000-8000-000000000002",
    versionId: "10000000-0000-4000-8000-000000000003",
    title: "AI Operating System Academy",
    description: "A production curriculum",
  },
  stages: [{
    id: "10000000-0000-4000-8000-000000000004", title: "Diagnose", order: 1,
    lessons: [{
      id: "10000000-0000-4000-8000-000000000005",
      lessonVersionId: "10000000-0000-4000-8000-000000000006",
      order: 1, required: true, title: "Map the journey", summary: "Map it.",
      durationSeconds: 420, releaseRule: { kind: "immediate" },
      availability: "available", availableAt: "2026-08-15T12:00:00.000Z",
      progress: "in_progress",
    }],
  }],
  progress: { completedRequired: 4, requiredTotal: 18, percent: 22 },
} as const;

describe("member learning course contracts", () => {
  it("accepts the exact pinned course projection and rejects unknown authority", () => {
    expect(MemberCourseResponseSchema.parse(course)).toEqual(course);
    expect(MemberCourseResponseSchema.safeParse({ ...course, accountId: crypto.randomUUID() }).success)
      .toBe(false);
  });

  it("accepts a released immutable lesson with personal resume and rejects mixed positions", () => {
    const lesson = {
      schemaVersion: 1,
      enrollmentId: course.enrollmentId,
      courseVersionId: course.course.versionId,
      lessonId: course.stages[0].lessons[0].id,
      lessonVersionId: course.stages[0].lessons[0].lessonVersionId,
      title: "Map the journey", summary: "Map it.", durationSeconds: 420,
      blocks: [{ type: "action", blockId: "action-1", title: "Map it", instructions: "Write the map." }],
      transcript: { schemaVersion: 1, blocks: [{ blockId: "transcript-1", text: "Accessible transcript." }] },
      resources: [{ id: "10000000-0000-4000-8000-000000000007", label: "Worksheet", accessibleLabel: "Download the journey worksheet", delivery: "external_https", mime: "application/pdf", byteSize: 12_345, availability: "ready" }],
      progress: { revision: 2, state: "in_progress", lastPath: "transcript", position: { blockId: "transcript-1" } },
      previousRequiredLessonId: null,
      nextRequiredLessonId: "10000000-0000-4000-8000-000000000008",
    } as const;
    expect(MemberLessonResponseSchema.parse(lesson)).toEqual(lesson);
    expect(MemberLessonResponseSchema.safeParse({
      ...lesson,
      progress: { ...lesson.progress, position: { seconds: 10 } },
    }).success).toBe(false);
  });

  it("keeps degraded video typed without inventing playback credentials", () => {
    const degraded = {
      schemaVersion: 1,
      lessonVersionId: course.stages[0].lessons[0].lessonVersionId,
      playbackStatus: "degraded",
      reason: "MUX_UNAVAILABLE",
      fallback: {
        title: "Diagnose the gap",
        summary: "A complete lesson.",
        blocks: [{ type: "action", blockId: "action-1", title: "Apply", instructions: "Complete the exercise." }],
        transcript: { schemaVersion: 1, blocks: [{ blockId: "transcript-1", text: "Complete transcript text." }] },
        resources: [],
      },
    } as const;
    expect(LessonPlaybackResponseSchema.parse(degraded)).toEqual(degraded);
    expect(LessonPlaybackResponseSchema.safeParse({ ...degraded, playbackToken: "secret" }).success)
      .toBe(false);
  });
});
