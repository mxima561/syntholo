import { MemberDashboard } from "@/features/dashboard/member-dashboard";
import { requireStudentAccount } from "@/lib/server/accounts";
import {
  getCompletedLessonIds,
  getInProgressLessonId,
  getPrimaryCourse,
} from "@/lib/server/courses";
import { listThreadsForUser, getThreadMessages } from "@/lib/server/support";
import { getCertificate, listArtifacts, listLiveSessions, listWorkflows } from "@syntholo/db";
import type { Route } from "next";

export const dynamic = "force-dynamic";

export default async function LearnDashboardPage() {
  const account = await requireStudentAccount();

  const [course, completedLessonIds, inProgressLessonId, threads, artifacts, workflows, sessions] = await Promise.all([
    getPrimaryCourse(),
    getCompletedLessonIds(account.id),
    getInProgressLessonId(account.id),
    listThreadsForUser(account.id),
    listArtifacts(account.id),
    listWorkflows(account.id),
    listLiveSessions(account.id),
  ]);
  const latestThread = threads[0];
  const messages = latestThread ? await getThreadMessages(latestThread.id, account.id) : [];
  const lastCoachMessage = messages.filter((message) => message.authorRole === "coach").at(-1);
  const coachThread = {
    subject: latestThread?.subject ?? "Your coach is ready",
    coachFirstName: (lastCoachMessage?.authorName ?? "Naomi Reed").split(" ")[0],
    lastMessage: lastCoachMessage?.body ?? "Send your first question and get a human response within two business days.",
  };

  const allLessons = course?.stages.flatMap((stage) => stage.lessons.map((lesson) => ({ ...lesson, stageTitle: stage.title }))) ?? [];
  const totalLessons = allLessons.length;
  const nextLesson =
    (inProgressLessonId ? allLessons.find((lesson) => lesson.id === inProgressLessonId) : undefined) ??
    allLessons.find((lesson) => !completedLessonIds.includes(lesson.id)) ??
    null;
  const nextHref = (nextLesson ? `/learn/course/${nextLesson.id}` : "/learn/plan") as Route;
  const draftArtifact = artifacts.find((artifact) => artifact.status !== "final");
  const nextWorkflow = workflows.find((workflow) => workflow.status !== "live");
  const upcoming = sessions.find((session) => session.status === "scheduled");
  const certificate = course ? await getCertificate(account.id, course.id) : null;

  const recommendations = [
    draftArtifact
      ? {
          label: "Implementation output",
          title: draftArtifact.title,
          description: "Keep this document specific enough for the team to use without you.",
          href: "/learn/plan" as Route,
          actionLabel: "Open workspace",
          tone: "coral" as const,
        }
      : {
          label: "Community",
          title: "Share one decision",
          description: "Post a useful update so other owners can compare notes.",
          href: "/learn/community" as Route,
          actionLabel: "Open community",
          tone: "coral" as const,
        },
    nextWorkflow
      ? {
          label: "Workflow",
          title: nextWorkflow.name,
          description: nextWorkflow.target || "Name the owner, human check, and target, then move it to testing.",
          href: "/learn/workflows" as Route,
          actionLabel: "Review workflow",
          tone: "gold" as const,
        }
      : {
          label: "Live session",
          title: upcoming?.title ?? "Office hours",
          description: "Bring one workflow and leave with a specific next action.",
          href: "/learn/live" as Route,
          actionLabel: "View sessions",
          tone: "gold" as const,
        },
  ];

  const priorities = [
    nextLesson?.actionLabel ?? "Review your implementation plan",
    draftArtifact?.title ?? "Finalize the required outputs",
    nextWorkflow?.name ?? "Keep three workflows live",
  ];

  return (
    <MemberDashboard
      certificateHref={certificate ? ("/learn/certificate" as Route) : null}
      coachThread={coachThread}
      nextHref={nextHref}
      nextLesson={nextLesson}
      priorities={priorities}
      progressPercent={totalLessons > 0 ? Math.round((completedLessonIds.length / totalLessons) * 100) : 0}
      publicId={account.publicId}
      recommendations={recommendations}
      upcomingSession={upcoming ? { title: upcoming.title, hostName: upcoming.hostName, region: upcoming.region } : null}
      workspaceName={account.businessName || `${account.firstName || "Your"} workspace`}
    />
  );
}
