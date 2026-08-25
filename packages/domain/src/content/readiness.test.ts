import { describe, expect, it } from "vitest";
import { REQUIRED_ACADEMY_LESSONS } from "./constants";
import {
  evaluateContentReadiness,
  isHumanApprovalCurrent,
  toContentLaunchReadiness,
  type PublishedCourseSnapshot,
  type PublishedLessonSnapshot,
} from "./readiness";
import { snapshotFromAcademyCourse } from "./snapshot";
import { validateLessonForPublication } from "./validation";

function lessonFixture(order: number, overrides: Partial<PublishedLessonSnapshot> = {}): PublishedLessonSnapshot {
  return {
    id: `lesson-${order}`,
    order,
    title: `Lesson ${order}`,
    summary: `Summary ${order}`,
    durationMinutes: 10,
    videoReady: true,
    captionsAssetId: `cap-${order}`,
    transcriptAssetId: `tr-${order}`,
    transcript: [`Transcript for lesson ${order}`],
    actionLabel: `Action ${order}`,
    resourceCount: 1,
    accessibilityApprovedAt: "2026-08-01T00:00:00.000Z",
    hasAction: true,
    hasResources: true,
    hasDisclosure: true,
    placeholder: false,
    ...overrides,
  };
}

function courseFixture(
  options: {
    requiredLessonCount?: number;
    placeholderLesson?: number;
    missingTranscript?: number;
    muxNotReady?: number;
    missingCaptions?: number;
    missingAction?: number;
    missingResource?: number;
    missingDisclosure?: number;
    missingAccessibility?: number;
  } = {},
): PublishedCourseSnapshot {
  const count = options.requiredLessonCount ?? REQUIRED_ACADEMY_LESSONS;
  return {
    courseId: "academy",
    requiredLessons: Array.from({ length: count }, (_, index) => {
      const order = index + 1;
      return lessonFixture(order, {
        placeholder: options.placeholderLesson === order,
        transcriptAssetId: options.missingTranscript === order ? null : `tr-${order}`,
        videoReady: options.muxNotReady === order ? false : true,
        captionsAssetId: options.missingCaptions === order ? null : `cap-${order}`,
        hasAction: options.missingAction === order ? false : true,
        hasResources: options.missingResource === order ? false : true,
        hasDisclosure: options.missingDisclosure === order ? false : true,
        accessibilityApprovedAt: options.missingAccessibility === order ? null : "2026-08-01T00:00:00.000Z",
      });
    }),
  };
}

function incompleteLesson(): PublishedLessonSnapshot {
  return lessonFixture(1, {
    videoReady: false,
    captionsAssetId: null,
    transcriptAssetId: null,
    hasAction: false,
    hasResources: false,
    accessibilityApprovedAt: null,
    hasDisclosure: false,
  });
}

describe("validateLessonForPublication", () => {
  it("returns all publication blockers", () => {
    expect(validateLessonForPublication(incompleteLesson()).map((issue) => issue.code)).toEqual([
      "VIDEO_NOT_READY",
      "CAPTIONS_REQUIRED",
      "TRANSCRIPT_REQUIRED",
      "ACTION_REQUIRED",
      "RESOURCE_REQUIRED",
      "ACCESSIBILITY_REVIEW_REQUIRED",
      "DISCLOSURE_REQUIRED",
    ]);
  });
});

describe("evaluateContentReadiness", () => {
  it.each([
    [courseFixture({ requiredLessonCount: 17 }), "REQUIRED_LESSON_COUNT"],
    [courseFixture({ requiredLessonCount: 19 }), "REQUIRED_LESSON_COUNT"],
    [courseFixture({ placeholderLesson: 3 }), "PLACEHOLDER_CONTENT"],
    [courseFixture({ missingTranscript: 5 }), "TRANSCRIPT_REQUIRED"],
    [courseFixture({ muxNotReady: 8 }), "VIDEO_NOT_READY"],
    [courseFixture({ missingCaptions: 2 }), "CAPTIONS_REQUIRED"],
    [courseFixture({ missingAction: 4 }), "ACTION_REQUIRED"],
    [courseFixture({ missingResource: 6 }), "RESOURCE_REQUIRED"],
    [courseFixture({ missingDisclosure: 7 }), "DISCLOSURE_REQUIRED"],
    [courseFixture({ missingAccessibility: 9 }), "ACCESSIBILITY_REVIEW_REQUIRED"],
  ] as const)("blocks an incomplete curriculum", (course, code) => {
    expect(evaluateContentReadiness(course).issues).toContainEqual(expect.objectContaining({ code }));
  });

  it("treats an empty curriculum as valid inventory that cannot sell", () => {
    const report = evaluateContentReadiness({ courseId: "academy", requiredLessons: [] });
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "REQUIRED_LESSON_COUNT" }));
    const readiness = toContentLaunchReadiness(report, null, new Date("2026-08-25T00:00:00.000Z"));
    expect(readiness.canSellAcademy).toBe(false);
    expect(readiness.readyLessons).toBe(0);
  });

  it("passes automated checks for 18 complete lessons", () => {
    const report = evaluateContentReadiness(courseFixture());
    expect(report.issues).toEqual([]);
    expect(report.readyLessons).toBe(18);
    const evaluatedAt = new Date("2026-08-25T12:00:00.000Z");
    const unapproved = toContentLaunchReadiness(report, null, evaluatedAt);
    expect(unapproved).toMatchObject({
      automatedPassedAt: evaluatedAt.toISOString(),
      humanApprovedAt: null,
      canSellAcademy: false,
    });
  });

  it("invalidates approval after a content change", () => {
    const original = evaluateContentReadiness(courseFixture());
    const changed = courseFixture();
    const nextLessons = [...changed.requiredLessons];
    nextLessons[0] = { ...nextLessons[0], title: "Changed title" };
    const updated = evaluateContentReadiness({ ...changed, requiredLessons: nextLessons });
    expect(isHumanApprovalCurrent({ approvedHash: original.contentHash, currentHash: updated.contentHash })).toBe(false);
    const readiness = toContentLaunchReadiness(updated, { contentHash: original.contentHash, approvedAt: new Date("2026-08-02T00:00:00.000Z") }, new Date());
    expect(readiness.canSellAcademy).toBe(false);
    expect(readiness.humanApprovedAt).toBeNull();
  });

  it("sells the academy only when automated and human gates match the current hash", () => {
    const report = evaluateContentReadiness(courseFixture());
    const evaluatedAt = new Date("2026-08-25T12:00:00.000Z");
    const readiness = toContentLaunchReadiness(
      report,
      { contentHash: report.contentHash, approvedAt: new Date("2026-08-24T00:00:00.000Z") },
      evaluatedAt,
    );
    expect(readiness.canSellAcademy).toBe(true);
    expect(readiness.humanApprovedAt).toBe("2026-08-24T00:00:00.000Z");
  });

  it("never treats the seeded academy placeholders as sellable", () => {
    const report = evaluateContentReadiness(snapshotFromAcademyCourse());
    expect(report.issues.some((issue) => issue.code === "PLACEHOLDER_CONTENT")).toBe(true);
    expect(toContentLaunchReadiness(report, null, new Date()).canSellAcademy).toBe(false);
  });
});
