import { describe, expect, it } from "vitest";
import {
  CreateCourseRequestSchema,
  CreateLessonRequestSchema,
  CreatePreviewRequestSchema,
  ContentPublicationConflictCodeSchema,
  ContentPublicationIssueSchema,
  PublishCourseRequestSchema,
  UpdateLessonRequestSchema,
} from "./courses.js";

describe("content course command contracts", () => {
  it("accepts strict authoring inputs without actor, review-time, or account authority", () => {
    expect(CreateCourseRequestSchema.parse({
      slug: "ai-operating-system", title: "AI Operating System", description: "A complete program",
    }).slug).toBe("ai-operating-system");
    expect(CreateLessonRequestSchema.parse({
      slug: "diagnose-1", title: "What an AI operating system is", order: 1,
      required: true, releaseRule: { kind: "immediate" },
    }).required).toBe(true);
    expect(() => CreateCourseRequestSchema.parse({
      slug: "course", title: "Course", description: "Description", accountId: crypto.randomUUID(),
    })).toThrow();
    expect(() => CreateLessonRequestSchema.parse({
      slug: "lesson", title: "Lesson", order: 1, required: true,
      releaseRule: { kind: "immediate" }, reviewerStaffId: crypto.randomUUID(),
    })).toThrow();
  });

  it("requires optimistic versioning for lesson edits and exact preview/head authority for publication", () => {
    expect(UpdateLessonRequestSchema.parse({ expectedVersion: 2, summary: "Updated summary" })).toEqual({
      expectedVersion: 2, summary: "Updated summary",
    });
    expect(CreatePreviewRequestSchema.parse({ expectedVersion: 3, reason: "Curriculum review" })).toEqual({
      expectedVersion: 3, reason: "Curriculum review",
    });
    const publish = PublishCourseRequestSchema.parse({
      previewId: "10000000-0000-4000-8000-000000000001",
      expectedManifestHash: "a".repeat(64), expectedHeadRevision: 0,
      reason: "Approved for production",
    });
    expect(publish.expectedHeadRevision).toBe(0);
    expect(() => PublishCourseRequestSchema.parse({ ...publish, expectedManifestHash: "abc" })).toThrow();
    expect(() => UpdateLessonRequestSchema.parse({ summary: "No version" })).toThrow();
  });

  it("keeps publication issues and conflicts closed and free of private relay fields", () => {
    expect(ContentPublicationIssueSchema.parse({
      code: "VIDEO_NOT_READY", field: "mediaAssetId",
      lessonId: "10000000-0000-4000-8000-000000000001",
    }).code).toBe("VIDEO_NOT_READY");
    expect(() => ContentPublicationIssueSchema.parse({
      code: "VIDEO_NOT_READY", field: "mediaAssetId", lessonId: null,
      providerError: "private",
    })).toThrow();
    expect(ContentPublicationConflictCodeSchema.options).toEqual([
      "CONTENT_NOT_READY", "MANIFEST_CHANGED", "COURSE_HEAD_CHANGED",
    ]);
  });
});
