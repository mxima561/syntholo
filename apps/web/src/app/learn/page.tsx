import { MemberDashboard } from "@/features/dashboard/member-dashboard";
import { getNextAction } from "@/lib/domain/next-action";
import { allLessons } from "@/lib/domain/course";
import { requireStudentAccount } from "@/lib/server/accounts";
import {
  getCompletedLessonIds,
  getInProgressLessonId,
  getPrimaryCourse,
} from "@/lib/server/courses";
import { listThreadsForUser, getThreadMessages } from "@/lib/server/support";
import { getDashboard } from "@/lib/demo/repository";

export const dynamic = "force-dynamic";

export default async function LearnDashboardPage() {
  const account = await requireStudentAccount();
  const demo = getDashboard("member-maria");

  const [course, completedLessonIds, inProgressLessonId, threads] = await Promise.all([
    getPrimaryCourse(),
    getCompletedLessonIds(account.id),
    getInProgressLessonId(account.id),
    listThreadsForUser(account.id),
  ]);
  const latestThread = threads[0];
  const messages = latestThread ? await getThreadMessages(latestThread.id) : [];
  const lastCoachMessage = messages.filter((message) => message.authorRole === "coach").at(-1);
  const coachThread = {
    subject: latestThread?.subject ?? "Your coach is ready",
    coachFirstName: (lastCoachMessage?.authorName ?? "Naomi Reed").split(" ")[0],
    lastMessage: lastCoachMessage?.body ?? "Send your first question and get a human response within two business days.",
  };

  const totalLessons = course?.stages.reduce((sum, stage) => sum + stage.lessons.length, 0) ?? allLessons.length;
  const nextLesson =
    (inProgressLessonId ? allLessons.find((lesson) => lesson.id === inProgressLessonId) : undefined) ??
    allLessons.find((lesson) => !completedLessonIds.includes(lesson.id)) ??
    allLessons[0];

  return (
    <MemberDashboard
      coachThread={coachThread}
      dashboard={{
        ...demo,
        member: {
          ...demo.member,
          firstName: account.firstName || account.email.split("@")[0],
          lastName: account.lastName,
          initials: account.initials,
        },
        organization: { ...demo.organization, name: `${account.firstName}'s workspace` },
        progressPercent: Math.round((completedLessonIds.length / totalLessons) * 100),
        completedCount: completedLessonIds.length,
        nextLesson,
        nextAction: getNextAction({ nextLessonId: nextLesson.id }),
      }}
    />
  );
}
