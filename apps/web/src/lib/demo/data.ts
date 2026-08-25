import { academyCourse } from "@/lib/domain/course";
import type {
  Artifact,
  CommunityPost,
  Entitlement,
  LessonProgress,
  LiveSession,
  Member,
  Organization,
  SoftwareAccount,
  SupportThread,
} from "@/lib/domain/types";

/** Test-only Northstar fixtures. Do not import from production pages, layouts, or accounts. */
export const SYNTHETIC_FIXTURE = true;

export const demoOrganization: Organization = {
  id: "org-northstar",
  name: "Northstar Advisory",
  category: "Management consulting",
  country: "United States",
  timezone: "America/New_York",
  supportEndsAt: "2027-07-30T23:59:59.000Z",
};

export const demoMembers: Member[] = [
  { id: "member-maria", organizationId: demoOrganization.id, firstName: "Maria", lastName: "Chen", title: "Founder", initials: "MC", role: "customer_owner" },
  { id: "member-daniel", organizationId: demoOrganization.id, firstName: "Daniel", lastName: "Brooks", title: "Client operations", initials: "DB", role: "customer_member" },
  { id: "member-rina", organizationId: demoOrganization.id, firstName: "Rina", lastName: "Patel", title: "Growth lead", initials: "RP", role: "customer_member" },
];

export const demoEntitlements: Entitlement[] = [
  { id: "ent-course", organizationId: demoOrganization.id, kind: "course", status: "active", startsAt: "2026-07-30T12:00:00.000Z", endsAt: null },
  { id: "ent-support", organizationId: demoOrganization.id, kind: "support", status: "active", startsAt: "2026-07-30T12:00:00.000Z", endsAt: demoOrganization.supportEndsAt },
  { id: "ent-community", organizationId: demoOrganization.id, kind: "community_write", status: "active", startsAt: "2026-07-30T12:00:00.000Z", endsAt: demoOrganization.supportEndsAt },
];

const completedIds = ["diagnose-1", "diagnose-2", "diagnose-3", "rules-1", "rules-2", "rules-3", "growth-1"];

export const demoProgress: LessonProgress[] = academyCourse.stages.flatMap((stage) =>
  stage.lessons.map((lesson) => ({
    memberId: "member-maria",
    lessonId: lesson.id,
    status: completedIds.includes(lesson.id) ? "completed" : lesson.id === "growth-2" ? "in_progress" : "not_started",
    resumeSeconds: lesson.id === "growth-2" ? 225 : 0,
    completedAt: completedIds.includes(lesson.id) ? "2026-08-08T16:00:00.000Z" : null,
  })),
);

export const demoArtifacts: Artifact[] = [
  { id: "readiness-map", organizationId: demoOrganization.id, kind: "readiness_map", title: "Readiness & opportunity map", status: "final", version: 3, updatedAt: "2026-08-04T14:30:00.000Z", updatedBy: "Maria Chen", reviewStatus: "none" },
  { id: "ai-policy", organizationId: demoOrganization.id, kind: "ai_policy", title: "Northstar team AI policy", status: "final", version: 2, updatedAt: "2026-08-08T17:15:00.000Z", updatedBy: "Daniel Brooks", reviewStatus: "feedback_ready" },
  {
    id: "workflow-portfolio",
    organizationId: demoOrganization.id,
    kind: "workflow_portfolio",
    title: "Three-workflow launch portfolio",
    status: "draft",
    version: 5,
    updatedAt: "2026-08-10T19:05:00.000Z",
    updatedBy: "Maria Chen",
    reviewStatus: "none",
    workflows: [
      { id: "wf-lead", name: "Instant lead response", engine: "growth", problem: "Warm leads wait until the next business day for a reply.", trigger: "Qualified website form submitted", owner: "Rina Patel", approvedTools: ["HighLevel", "Gmail"], steps: ["Capture form", "Score required fields", "Send personal response draft", "Route to owner"], humanReviewPoint: "Owner approves any custom scope language", safetyNotes: "No confidential client data enters the lead workflow", baseline: "9-hour median response", target: "Under 10 minutes", status: "live", launchDate: "2026-08-09T13:00:00.000Z" },
      { id: "wf-onboarding", name: "Client onboarding launch", engine: "client", problem: "New clients receive inconsistent setup instructions.", trigger: "Agreement marked signed", owner: "Daniel Brooks", approvedTools: ["HighLevel", "Google Drive"], steps: ["Create client record", "Send kickoff form", "Create shared folder", "Schedule kickoff"], humanReviewPoint: "Daniel verifies service scope", safetyNotes: "Folder permissions reviewed before email", baseline: "3 days to kickoff ready", target: "1 business day", status: "testing", launchDate: null },
      { id: "wf-weekly", name: "Weekly owner brief", engine: "management", problem: "Reporting takes Friday afternoon to prepare.", trigger: "Thursday 4pm", owner: "Maria Chen", approvedTools: ["Google Sheets", "ChatGPT Team"], steps: ["Collect approved metrics", "Summarize changes", "Flag decisions", "Owner review"], humanReviewPoint: "Maria checks every recommendation", safetyNotes: "Client names excluded from the summary", baseline: "3.5 hours weekly", target: "45 minutes", status: "draft", launchDate: null },
    ],
  },
  { id: "enablement", organizationId: demoOrganization.id, kind: "enablement_checklist", title: "Team enablement checklist", status: "not_started", version: 1, updatedAt: "2026-08-10T19:00:00.000Z", updatedBy: "Maria Chen", reviewStatus: "none" },
  { id: "roadmap", organizationId: demoOrganization.id, kind: "roadmap", title: "90-day roadmap", status: "not_started", version: 1, updatedAt: "2026-08-10T19:00:00.000Z", updatedBy: "Maria Chen", reviewStatus: "none" },
];

export const demoSupportThreads: SupportThread[] = [
  {
    id: "thread-policy",
    organizationId: demoOrganization.id,
    subject: "Feedback on our data-handling section",
    category: "artifact_review",
    status: "waiting_on_customer",
    assignedCoachId: "coach-naomi",
    assignedCoachName: "Naomi Reed",
    slaDueAt: "2026-08-12T21:00:00.000Z",
    relatedArtifactId: "ai-policy",
    messages: [
      { id: "msg-1", authorId: "member-maria", authorName: "Maria Chen", authorRole: "customer", body: "Can you check whether our rule for client call notes is specific enough?", createdAt: "2026-08-08T15:00:00.000Z" },
      { id: "msg-2", authorId: "coach-naomi", authorName: "Naomi Reed", authorRole: "coach", body: "The boundary is strong. Add one line naming who can approve an exception, then this is ready to share with the team.", createdAt: "2026-08-09T18:15:00.000Z" },
    ],
  },
  {
    id: "thread-routing",
    organizationId: demoOrganization.id,
    subject: "Should every lead receive the same booking link?",
    category: "workflow",
    status: "resolved",
    assignedCoachId: "coach-naomi",
    assignedCoachName: "Naomi Reed",
    slaDueAt: "2026-08-07T21:00:00.000Z",
    messages: [
      { id: "msg-3", authorId: "member-rina", authorName: "Rina Patel", authorRole: "customer", body: "We have two service lines with different discovery calls.", createdAt: "2026-08-05T14:00:00.000Z" },
      { id: "msg-4", authorId: "coach-naomi", authorName: "Naomi Reed", authorRole: "coach", body: "Use qualification answers to route to two calendars. Keep one fallback path for anything ambiguous.", createdAt: "2026-08-06T15:40:00.000Z" },
    ],
  },
];

export const demoSessions: LiveSession[] = [
  { id: "session-americas", title: "Workflow office hours", description: "Bring one workflow map for direct, practical feedback.", startsAt: "2026-08-13T17:00:00.000Z", endsAt: "2026-08-13T18:00:00.000Z", region: "Americas", hostName: "Naomi Reed", status: "scheduled", capacity: 100, rsvpCount: 38, hasRecording: false },
  { id: "session-europe", title: "Workflow office hours", description: "The repeated monthly session for Europe and Asia-friendly time zones.", startsAt: "2026-08-14T08:00:00.000Z", endsAt: "2026-08-14T09:00:00.000Z", region: "Europe / Asia", hostName: "Leon Park", status: "scheduled", capacity: 100, rsvpCount: 27, hasRecording: false },
  { id: "session-recording", title: "Choosing your first useful workflow", description: "A practical review of impact, effort, and team readiness.", startsAt: "2026-08-01T17:00:00.000Z", endsAt: "2026-08-01T18:00:00.000Z", region: "Pilot cohort", hostName: "Naomi Reed", status: "completed", capacity: 50, rsvpCount: 14, hasRecording: true },
];

export const demoCommunityPosts: CommunityPost[] = [
  { id: "post-1", space: "Implementation Wins", authorName: "Sam Ortega", authorRole: "Founder", businessName: "Ortega Studio", initials: "SO", title: "We cut our proposal prep from 90 minutes to 25", body: "The win was not the prompt—it was agreeing on the inputs and the human review point. The proposal still sounds like us.", createdAt: "2026-08-10T16:30:00.000Z", commentCount: 12, reactionCount: 34, status: "published" },
  { id: "post-2", space: "Growth Engine", authorName: "Helen Brooks", authorRole: "Managing partner", businessName: "Brooks & Field", initials: "HB", title: "What are you using as the fallback for ambiguous leads?", body: "Our qualification rules work for 80% of inquiries. I would love to compare how others route the edge cases.", createdAt: "2026-08-09T13:10:00.000Z", commentCount: 8, reactionCount: 9, status: "published" },
  { id: "post-3", space: "Management Engine", authorName: "Imani Cole", authorRole: "Operations director", businessName: "Clearpath Legal Ops", initials: "IC", title: "Our first weekly owner brief is live", body: "We reduced the report to six measures and three decisions. Leadership actually read it this time.", createdAt: "2026-08-08T19:45:00.000Z", commentCount: 6, reactionCount: 21, status: "published" },
];

export const demoSoftwareAccount: SoftwareAccount = {
  id: "software-northstar",
  organizationId: demoOrganization.id,
  status: "pending_onboarding",
  questionnairePercent: 65,
  provisioningStartedAt: null,
  provisioningDueAt: null,
  externalUrl: null,
  checklist: [
    { id: "brand", label: "Brand and business details", complete: true },
    { id: "pipeline", label: "Pipeline stages", complete: true },
    { id: "calendar", label: "Calendar and availability", complete: false },
    { id: "messaging", label: "Messaging registration", complete: false },
    { id: "assistant", label: "AI assistant scope", complete: true },
  ],
};

