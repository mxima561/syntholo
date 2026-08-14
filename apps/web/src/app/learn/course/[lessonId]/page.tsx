import { notFound } from "next/navigation";
import { ProductionMemberAccess } from "@/components/production-member-access";
import { isDemoMode } from "@/lib/config/mode";

export default async function LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  if (!isDemoMode()) return <ProductionMemberAccess />;
  const [{ LessonWorkspace }, { getLesson, getMemberCourse }] = await Promise.all([
    import("@/features/course/lesson-workspace"),
    import("@/lib/demo/repository"),
  ]);
  const { lessonId } = await params;
  const lesson = getLesson(lessonId);
  if (!lesson) notFound();
  const { completedLessonIds } = getMemberCourse("member-maria");

  return <div className="member-page lesson-page"><LessonWorkspace initiallyComplete={completedLessonIds.includes(lesson.id)} lesson={lesson} /></div>;
}
