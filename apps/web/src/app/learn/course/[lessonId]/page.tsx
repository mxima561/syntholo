import { notFound } from "next/navigation";
import { LessonWorkspace } from "@/features/course/lesson-workspace";
import { getLesson, getMemberCourse } from "@/lib/demo/repository";

export default async function LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  const lesson = getLesson(lessonId);
  if (!lesson) notFound();
  const { completedLessonIds } = getMemberCourse("member-maria");

  return <div className="member-page lesson-page"><LessonWorkspace initiallyComplete={completedLessonIds.includes(lesson.id)} lesson={lesson} /></div>;
}
