type LessonBlock = Readonly<{
  type: string;
  blockId: string;
  [key: string]: unknown;
}>;
type Transcript = Readonly<{ schemaVersion: 1; blocks: readonly Readonly<{ blockId: string; text: string }>[] }>;
type PublicationIssueCode =
  | "TITLE_REQUIRED" | "SUMMARY_REQUIRED" | "DURATION_OUT_OF_RANGE"
  | "VIDEO_NOT_READY" | "SIGNED_PLAYBACK_REQUIRED" | "CAPTIONS_REQUIRED"
  | "TRANSCRIPT_REQUIRED" | "ACTION_REQUIRED" | "RESOURCE_REQUIRED"
  | "ACCESSIBILITY_REVIEW_REQUIRED" | "DISCLOSURE_DECISION_REQUIRED"
  | "PLACEHOLDER_CONTENT";
export type PublicationIssue = Readonly<{
  code: PublicationIssueCode;
  field: string;
  lessonId: string | null;
}>;

export type LessonPublicationCandidate = Readonly<{
  lessonId: string;
  title: string;
  summary: string;
  durationSeconds: number | null;
  blocks: readonly LessonBlock[];
  transcript: Transcript;
  mediaAssetId: string | null;
  mediaReady: boolean;
  signedPlaybackReady: boolean;
  captionsReady: boolean;
  readyResourceCount: number;
  accessibilityApproved: boolean;
  disclosureDecided: boolean;
  placeholderDetected: boolean;
}>;

export function publicationIssuesForLesson(candidate: LessonPublicationCandidate): PublicationIssue[] {
  const issues: PublicationIssue[] = [];
  const add = (code: PublicationIssue["code"], field: string) => {
    issues.push({ code, field, lessonId: candidate.lessonId });
  };
  if (candidate.title.trim() === "" || /^(todo|tbd|placeholder)$/iu.test(candidate.title.trim())) add("TITLE_REQUIRED", "title");
  if (candidate.summary.trim() === "") add("SUMMARY_REQUIRED", "summary");
  if (candidate.durationSeconds === null || candidate.durationSeconds < 300 || candidate.durationSeconds > 720) add("DURATION_OUT_OF_RANGE", "durationSeconds");
  const videoBlocks = candidate.blocks.filter(({ type }) => type === "video");
  const videoBlock = videoBlocks[0];
  const exactVideoBinding = videoBlocks.length === 1
    && candidate.mediaAssetId !== null
    && typeof videoBlock?.mediaAssetId === "string"
    && videoBlock.mediaAssetId === candidate.mediaAssetId;
  if (!candidate.mediaReady || !exactVideoBinding) add("VIDEO_NOT_READY", "mediaAssetId");
  if (!candidate.signedPlaybackReady) add("SIGNED_PLAYBACK_REQUIRED", "mediaAssetId");
  if (!candidate.captionsReady) add("CAPTIONS_REQUIRED", "captions");
  if (candidate.transcript.blocks.length === 0) add("TRANSCRIPT_REQUIRED", "transcript");
  if (!candidate.blocks.some(({ type }) => type === "action")) add("ACTION_REQUIRED", "blocks");
  if (candidate.readyResourceCount < 1) add("RESOURCE_REQUIRED", "resources");
  if (!candidate.accessibilityApproved) add("ACCESSIBILITY_REVIEW_REQUIRED", "accessibilityDecision");
  if (!candidate.disclosureDecided) add("DISCLOSURE_DECISION_REQUIRED", "disclosureDecision");
  if (candidate.placeholderDetected) add("PLACEHOLDER_CONTENT", "content");
  return issues;
}
