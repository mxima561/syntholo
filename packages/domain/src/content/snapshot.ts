import { academyCourse } from "../course";
import type { PublishedCourseSnapshot, PublishedLessonSnapshot } from "./readiness";

function asSnapshotLesson(lesson: (typeof academyCourse.stages)[number]["lessons"][number]): PublishedLessonSnapshot {
  return {
    id: lesson.id,
    order: lesson.number,
    title: lesson.title,
    summary: lesson.summary,
    durationMinutes: lesson.durationMinutes,
    videoReady: false,
    captionsAssetId: null,
    transcriptAssetId: null,
    transcript: lesson.transcript,
    actionLabel: lesson.actionLabel,
    resourceCount: lesson.resourceCount,
    accessibilityApprovedAt: null,
    hasAction: Boolean(lesson.actionLabel),
    hasResources: lesson.resourceCount > 0,
    hasDisclosure: false,
    placeholder: true,
  };
}

/** Current seeded academy copy is placeholder curriculum and cannot satisfy Gate 3. */
export function snapshotFromAcademyCourse(course = academyCourse): PublishedCourseSnapshot {
  return {
    courseId: course.id,
    requiredLessons: course.stages.flatMap((stage) => stage.lessons.filter((lesson) => lesson.required).map(asSnapshotLesson)),
  };
}
