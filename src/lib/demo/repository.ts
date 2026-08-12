import { academyCourse, allLessons } from "@/lib/domain/course";
import { getNextAction } from "@/lib/domain/next-action";
import {
  demoArtifacts,
  demoCommunityPosts,
  demoEntitlements,
  demoMembers,
  demoOrganization,
  demoProgress,
  demoSessions,
  demoSoftwareAccount,
  demoSupportThreads,
} from "./data";

export function getDashboard(memberId: string) {
  const member = demoMembers.find((candidate) => candidate.id === memberId) ?? demoMembers[0];
  const completedCount = demoProgress.filter(
    (progress) => progress.memberId === member.id && progress.status === "completed",
  ).length;
  const nextLesson = demoProgress.find(
    (progress) => progress.memberId === member.id && progress.status === "in_progress",
  );

  return {
    organization: demoOrganization,
    member,
    members: demoMembers,
    progressPercent: Math.round((completedCount / academyCourse.requiredLessonCount) * 100),
    completedCount,
    artifacts: demoArtifacts,
    upcomingSession: demoSessions.find((session) => session.status === "scheduled"),
    supportThreads: demoSupportThreads,
    entitlements: demoEntitlements,
    softwareAccount: demoSoftwareAccount,
    nextAction: getNextAction({ nextLessonId: nextLesson?.lessonId ?? "growth-2" }),
  };
}

export function getMemberCourse(memberId: string) {
  return {
    course: academyCourse,
    progress: demoProgress.filter((item) => item.memberId === memberId),
    completedLessonIds: demoProgress
      .filter((item) => item.memberId === memberId && item.status === "completed")
      .map((item) => item.lessonId),
    artifacts: demoArtifacts,
  };
}

export function getLesson(lessonId: string) {
  return allLessons.find((lesson) => lesson.id === lessonId);
}

export function getHumanLayer() {
  return {
    threads: demoSupportThreads,
    sessions: demoSessions,
    posts: demoCommunityPosts,
  };
}

export function getBusinessOs() {
  return demoSoftwareAccount;
}

