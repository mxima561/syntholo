import { notFound } from "next/navigation";
import { LessonWorkspace } from "@/features/course/lesson-workspace";
import { requireStudentAccount } from "@/lib/server/accounts";
import { getCompletedLessonIds, getLessonById } from "@/lib/server/courses";

export const dynamic = "force-dynamic";

export default async function LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  const account = await requireStudentAccount();
  const lesson = await getLessonById(lessonId);
  if (!lesson) notFound();

  const completedLessonIds = await getCompletedLessonIds(account.id);

  return (
    <div className="member-page lesson-page">
      <LessonWorkspace
        initiallyComplete={completedLessonIds.includes(lesson.id)}
        lesson={{
          id: lesson.id,
          stageId: lesson.stageId,
          number: lesson.number,
          title: lesson.title,
          summary: lesson.summary,
          durationMinutes: lesson.durationMinutes,
          required: lesson.required,
          actionLabel: lesson.actionLabel,
          transcript: lesson.transcript,
          resourceCount: lesson.resourceCount,
        }}
        videoUrl={lesson.videoUrl}
      />
    </div>
  );
}
