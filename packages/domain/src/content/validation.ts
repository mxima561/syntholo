export const PUBLICATION_ISSUE_CODES = [
  "TITLE_REQUIRED",
  "SUMMARY_REQUIRED",
  "DURATION_REQUIRED",
  "VIDEO_NOT_READY",
  "CAPTIONS_REQUIRED",
  "TRANSCRIPT_REQUIRED",
  "ACTION_REQUIRED",
  "RESOURCE_REQUIRED",
  "ACCESSIBILITY_REVIEW_REQUIRED",
  "DISCLOSURE_REQUIRED",
  "PLACEHOLDER_CONTENT",
] as const;

export type PublicationIssueCode = (typeof PUBLICATION_ISSUE_CODES)[number];

export type PublicationIssue = Readonly<{
  code: PublicationIssueCode;
  message: string;
}>;

export type LessonPublicationInput = Readonly<{
  id: string;
  order: number;
  title: string;
  summary: string;
  durationMinutes: number;
  videoReady: boolean;
  captionsAssetId: string | null;
  transcriptAssetId: string | null;
  transcript?: readonly string[];
  actionLabel?: string;
  resourceCount?: number;
  accessibilityApprovedAt: string | null;
  hasAction: boolean;
  hasResources: boolean;
  hasDisclosure: boolean;
  placeholder: boolean;
}>;

const PLACEHOLDER_PATTERN = /\[placeholder\]|lorem ipsum|todo:\s*replace|placeholder content/i;

const ISSUE_MESSAGES: Record<PublicationIssueCode, string> = {
  TITLE_REQUIRED: "A lesson title is required",
  SUMMARY_REQUIRED: "A lesson summary is required",
  DURATION_REQUIRED: "A positive duration is required",
  VIDEO_NOT_READY: "A ready Mux video asset is required",
  CAPTIONS_REQUIRED: "Captions are required",
  TRANSCRIPT_REQUIRED: "A transcript is required",
  ACTION_REQUIRED: "An action is required",
  RESOURCE_REQUIRED: "At least one resource is required",
  ACCESSIBILITY_REVIEW_REQUIRED: "Accessibility review is required",
  DISCLOSURE_REQUIRED: "A required disclosure is missing",
  PLACEHOLDER_CONTENT: "Placeholder content remains",
};

function issue(code: PublicationIssueCode): PublicationIssue {
  return { code, message: ISSUE_MESSAGES[code] };
}

export function hasPlaceholderMarker(lesson: LessonPublicationInput): boolean {
  if (lesson.placeholder) return true;
  const blob = [lesson.title, lesson.summary, lesson.actionLabel ?? "", ...(lesson.transcript ?? [])].join("\n");
  return PLACEHOLDER_PATTERN.test(blob);
}

export function validateLessonForPublication(lesson: LessonPublicationInput): readonly PublicationIssue[] {
  const issues: PublicationIssue[] = [];
  if (!lesson.title.trim()) issues.push(issue("TITLE_REQUIRED"));
  if (!lesson.summary.trim()) issues.push(issue("SUMMARY_REQUIRED"));
  if (!(lesson.durationMinutes > 0)) issues.push(issue("DURATION_REQUIRED"));
  if (!lesson.videoReady) issues.push(issue("VIDEO_NOT_READY"));
  if (!lesson.captionsAssetId) issues.push(issue("CAPTIONS_REQUIRED"));
  if (!lesson.transcriptAssetId) issues.push(issue("TRANSCRIPT_REQUIRED"));
  if (!lesson.hasAction) issues.push(issue("ACTION_REQUIRED"));
  if (!lesson.hasResources) issues.push(issue("RESOURCE_REQUIRED"));
  if (!lesson.accessibilityApprovedAt) issues.push(issue("ACCESSIBILITY_REVIEW_REQUIRED"));
  if (!lesson.hasDisclosure) issues.push(issue("DISCLOSURE_REQUIRED"));
  if (hasPlaceholderMarker(lesson)) issues.push(issue("PLACEHOLDER_CONTENT"));
  return issues;
}
