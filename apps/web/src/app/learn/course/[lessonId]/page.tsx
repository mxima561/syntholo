import { ProductionLessonWorkspace } from "@/components/production-lesson-workspace";

export default async function LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  return <ProductionLessonWorkspace lessonId={lessonId} />;
}
