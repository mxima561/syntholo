import { describe, expect, it } from "vitest";
import { getNextAction } from "./next-action";

describe("getNextAction", () => {
  it("puts account access ahead of every learning action", () => {
    expect(
      getNextAction({
        accessIssue: "Update your payment method",
        waitingOnCustomerThreadId: "thread-1",
        upcomingSessionId: "session-1",
        nextLessonId: "lesson-4",
        incompleteArtifactId: "policy",
      }),
    ).toEqual({
      kind: "access_issue",
      href: "/learn/settings/billing",
      label: "Update your payment method",
    });
  });

  it("puts a coach response ahead of an upcoming session", () => {
    expect(
      getNextAction({
        waitingOnCustomerThreadId: "thread-1",
        upcomingSessionId: "session-1",
        nextLessonId: "lesson-4",
      }).kind,
    ).toBe("coach_response");
  });

  it("returns a lesson when no urgent item exists", () => {
    expect(getNextAction({ nextLessonId: "growth-1" })).toEqual({
      kind: "lesson",
      href: "/learn/course/growth-1",
      label: "Continue your next lesson",
    });
  });
});

