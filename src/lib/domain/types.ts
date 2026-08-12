export type IsoDate = string;

export type MemberRole = "customer_owner" | "customer_member" | "coach" | "admin";

export type Organization = {
  id: string;
  name: string;
  category: string;
  country: string;
  timezone: string;
  supportEndsAt: IsoDate;
};

export type Member = {
  id: string;
  organizationId: string;
  firstName: string;
  lastName: string;
  title: string;
  initials: string;
  role: MemberRole;
};

export type EntitlementKind =
  | "course"
  | "support"
  | "community_write"
  | "operator_club"
  | "business_os";

export type EntitlementStatus = "active" | "grace" | "expired" | "refunded" | "revoked";

export type Entitlement = {
  id: string;
  organizationId: string;
  kind: EntitlementKind;
  status: EntitlementStatus;
  startsAt: IsoDate;
  endsAt: IsoDate | null;
};

export type Lesson = {
  id: string;
  stageId: string;
  number: number;
  title: string;
  summary: string;
  durationMinutes: number;
  required: boolean;
  actionLabel: string;
  transcript: string[];
  resourceCount: number;
  relationship?: "affiliate" | "white_label";
};

export type CourseStage = {
  id: string;
  number: number;
  title: string;
  shortTitle: string;
  description: string;
  releaseWeek: number;
  lessons: Lesson[];
};

export type Course = {
  id: string;
  title: string;
  description: string;
  stages: CourseStage[];
  requiredLessonCount: number;
};

export type LessonProgress = {
  memberId: string;
  lessonId: string;
  status: "not_started" | "in_progress" | "completed";
  resumeSeconds: number;
  completedAt: IsoDate | null;
};

export type ArtifactKind =
  | "readiness_map"
  | "ai_policy"
  | "workflow_portfolio"
  | "enablement_checklist"
  | "roadmap";

export type WorkflowStatus = "draft" | "testing" | "live" | "paused";

export type WorkflowRecord = {
  id: string;
  name: string;
  engine: "growth" | "client" | "management";
  problem: string;
  trigger: string;
  owner: string;
  approvedTools: string[];
  steps: string[];
  humanReviewPoint: string;
  safetyNotes: string;
  baseline: string;
  target: string;
  status: WorkflowStatus;
  launchDate: IsoDate | null;
};

export type Artifact = {
  id: string;
  organizationId: string;
  kind: ArtifactKind;
  title: string;
  status: "not_started" | "draft" | "final";
  version: number;
  updatedAt: IsoDate;
  updatedBy: string;
  reviewStatus: "none" | "requested" | "in_review" | "feedback_ready";
  workflows?: WorkflowRecord[];
};

export type SupportThreadStatus =
  | "new"
  | "assigned"
  | "waiting_on_coach"
  | "waiting_on_customer"
  | "resolved"
  | "closed";

export type SupportMessage = {
  id: string;
  authorId: string;
  authorName: string;
  authorRole: "customer" | "coach";
  body: string;
  createdAt: IsoDate;
};

export type SupportThread = {
  id: string;
  organizationId: string;
  subject: string;
  category: "course" | "workflow" | "artifact_review" | "tool_selection";
  status: SupportThreadStatus;
  assignedCoachId: string;
  assignedCoachName: string;
  slaDueAt: IsoDate;
  relatedArtifactId?: string;
  messages: SupportMessage[];
};

export type LiveSession = {
  id: string;
  title: string;
  description: string;
  startsAt: IsoDate;
  endsAt: IsoDate;
  region: "Americas" | "Europe / Asia" | "Pilot cohort";
  hostName: string;
  status: "scheduled" | "live" | "completed" | "canceled";
  capacity: number;
  rsvpCount: number;
  hasRecording: boolean;
};

export type CommunityPost = {
  id: string;
  space: string;
  authorName: string;
  authorRole: string;
  businessName: string;
  initials: string;
  title: string;
  body: string;
  createdAt: IsoDate;
  commentCount: number;
  reactionCount: number;
  status: "published" | "reported" | "hidden";
};

export type SoftwareAccountStatus =
  | "pending_onboarding"
  | "provisioning"
  | "active"
  | "paused"
  | "canceled";

export type SoftwareAccount = {
  id: string;
  organizationId: string;
  status: SoftwareAccountStatus;
  questionnairePercent: number;
  provisioningStartedAt: IsoDate | null;
  provisioningDueAt: IsoDate | null;
  externalUrl: string | null;
  checklist: Array<{ id: string; label: string; complete: boolean }>;
};

export type NextActionKind =
  | "access_issue"
  | "coach_response"
  | "live_session"
  | "lesson"
  | "artifact"
  | "feedback"
  | "community";

export type NextAction = {
  kind: NextActionKind;
  label: string;
  href: string;
};

