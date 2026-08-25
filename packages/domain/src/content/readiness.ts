import { createHash } from "node:crypto";
import { REQUIRED_ACADEMY_LESSONS } from "./constants";
import { hasPlaceholderMarker, validateLessonForPublication, type LessonPublicationInput } from "./validation";

export type PublishedLessonSnapshot = LessonPublicationInput;

export type PublishedCourseSnapshot = Readonly<{
  courseId: string;
  requiredLessons: readonly PublishedLessonSnapshot[];
}>;

export type ContentReadinessIssue = Readonly<{
  lessonId: string | null;
  code: string;
  message: string;
}>;

export type ContentReadinessReport = Readonly<{
  requiredLessons: typeof REQUIRED_ACADEMY_LESSONS;
  readyLessons: number;
  issues: readonly ContentReadinessIssue[];
  contentHash: string;
}>;

export type ContentApproval = Readonly<{
  contentHash: string;
  approvedAt: Date;
}>;

export type ContentLaunchReadiness = Readonly<{
  requiredLessons: typeof REQUIRED_ACADEMY_LESSONS;
  readyLessons: number;
  contentHash: string;
  automatedPassedAt: string | null;
  humanApprovedAt: string | null;
  canSellAcademy: boolean;
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function publicationFields(lesson: PublishedLessonSnapshot) {
  return {
    id: lesson.id,
    order: lesson.order,
    title: lesson.title,
    summary: lesson.summary,
    durationMinutes: lesson.durationMinutes,
    videoReady: lesson.videoReady,
    captionsAssetId: lesson.captionsAssetId,
    transcriptAssetId: lesson.transcriptAssetId,
    accessibilityApprovedAt: lesson.accessibilityApprovedAt,
    hasAction: lesson.hasAction,
    hasResources: lesson.hasResources,
    hasDisclosure: lesson.hasDisclosure,
    placeholder: hasPlaceholderMarker(lesson),
  };
}

export function contentHashForLessons(lessons: readonly PublishedLessonSnapshot[]): string {
  const canonical = [...lessons]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(publicationFields);
  return createHash("sha256").update(canonicalJson(canonical)).digest("hex");
}

export function evaluateContentReadiness(course: PublishedCourseSnapshot): ContentReadinessReport {
  const lessons = [...course.requiredLessons].sort((left, right) => left.order - right.order);
  const issues: ContentReadinessIssue[] = [];

  if (lessons.length !== REQUIRED_ACADEMY_LESSONS) {
    issues.push({
      lessonId: null,
      code: "REQUIRED_LESSON_COUNT",
      message: "Exactly 18 required lessons are required",
    });
  }

  for (const lesson of lessons) {
    for (const issue of validateLessonForPublication(lesson)) {
      issues.push({ lessonId: lesson.id, ...issue });
    }
  }

  const blockedLessonIds = new Set(issues.map((issue) => issue.lessonId).filter((id): id is string => Boolean(id)));
  const readyLessons = Math.max(0, lessons.length - blockedLessonIds.size);

  return {
    requiredLessons: REQUIRED_ACADEMY_LESSONS,
    readyLessons,
    issues,
    contentHash: contentHashForLessons(lessons),
  };
}

export function isHumanApprovalCurrent(input: { approvedHash: string; currentHash: string }): boolean {
  return Boolean(input.approvedHash) && input.approvedHash === input.currentHash;
}

export function toContentLaunchReadiness(
  report: ContentReadinessReport,
  approval: ContentApproval | null,
  evaluatedAt: Date,
): ContentLaunchReadiness {
  const automatedPassedAt = report.issues.length === 0 ? evaluatedAt.toISOString() : null;
  const humanApprovedAt =
    approval && isHumanApprovalCurrent({ approvedHash: approval.contentHash, currentHash: report.contentHash })
      ? approval.approvedAt.toISOString()
      : null;
  return {
    requiredLessons: REQUIRED_ACADEMY_LESSONS,
    readyLessons: report.readyLessons,
    contentHash: report.contentHash,
    automatedPassedAt,
    humanApprovedAt,
    canSellAcademy: automatedPassedAt !== null && humanApprovedAt !== null,
  };
}

export function formatContentGateReport(readiness: ContentLaunchReadiness, issues: readonly ContentReadinessIssue[]): string {
  const status = readiness.canSellAcademy ? "PASS" : "BLOCKED";
  const issueLines = issues.map((issue) =>
    issue.lessonId ? `  - ${issue.lessonId}: ${issue.code} ${issue.message}` : `  - ${issue.code} ${issue.message}`,
  );
  return [
    `Academy content gate: ${status}`,
    `requiredLessons: ${readiness.requiredLessons}`,
    `readyLessons: ${readiness.readyLessons}`,
    `canSellAcademy: ${readiness.canSellAcademy}`,
    `automatedPassedAt: ${readiness.automatedPassedAt}`,
    `humanApprovedAt: ${readiness.humanApprovedAt}`,
    `contentHash: ${readiness.contentHash}`,
    "issues:",
    ...(issueLines.length > 0 ? issueLines : ["  - none"]),
  ].join("\n");
}
