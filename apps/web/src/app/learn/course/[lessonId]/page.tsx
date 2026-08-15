import { notFound } from "next/navigation";
import { ProductionLessonWorkspace } from "@/components/production-lesson-workspace";
import { isDemoMode } from "@/lib/config/mode";

export default async function LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  if (!isDemoMode()) return <ProductionLessonWorkspace lessonId={lessonId} />;
  const [{ LessonWorkspace }, { getLesson, getMemberCourse }] = await Promise.all([
    import("@/features/course/lesson-workspace"),
    import("@/lib/demo/repository"),
  ]);
  const lesson = getLesson(lessonId);
  if (!lesson) notFound();
  const { completedLessonIds } = getMemberCourse("member-maria");

  return <div className="member-page lesson-page"><LessonWorkspace initiallyComplete={completedLessonIds.includes(lesson.id)} lesson={lesson} /></div>;
}
