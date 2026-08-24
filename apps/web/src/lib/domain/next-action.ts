import type { NextAction } from "./types";

export type NextActionInput = {
  accessIssue?: string;
  waitingOnCustomerThreadId?: string;
  upcomingSessionId?: string;
  nextLessonId?: string;
  incompleteArtifactId?: string;
  feedbackArtifactId?: string;
};

export function getNextAction(input: NextActionInput): NextAction {
  if (input.accessIssue) {
    return { kind: "access_issue", label: input.accessIssue, href: "/learn/settings/billing" };
  }
  if (input.waitingOnCustomerThreadId) {
    return {
      kind: "coach_response",
      label: "Reply to your human coach",
      href: `/learn/support?thread=${input.waitingOnCustomerThreadId}`,
    };
  }
  if (input.upcomingSessionId) {
    return {
      kind: "live_session",
      label: "Prepare for your upcoming live session",
      href: `/learn/live?session=${input.upcomingSessionId}`,
    };
  }
  if (input.nextLessonId) {
    return {
      kind: "lesson",
      label: "Continue your next lesson",
      href: `/learn/course/${input.nextLessonId}`,
    };
  }
  if (input.incompleteArtifactId) {
    return {
      kind: "artifact",
      label: "Finish your next business output",
      href: `/learn/plan?artifact=${input.incompleteArtifactId}`,
    };
  }
  if (input.feedbackArtifactId) {
    return {
      kind: "feedback",
      label: "Review feedback from your coach",
      href: `/learn/plan?artifact=${input.feedbackArtifactId}`,
    };
  }
  return { kind: "community", label: "See what other owners are building", href: "/learn/community" };
}

