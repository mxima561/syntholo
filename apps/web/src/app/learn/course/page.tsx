import { CourseMap } from "@/features/course/course-map";
import { requireStudentAccount } from "@/lib/server/accounts";
import { getCompletedLessonIds, getInProgressLessonId, getPrimaryCourse } from "@/lib/server/courses";

export const dynamic = "force-dynamic";

export default async function CourseMapPage() {
  const account = await requireStudentAccount();
  const course = await getPrimaryCourse();

  if (!course) {
    return (
      <div className="member-page course-page">
        <section className="page-intro">
          <div>
            <h1>No published course yet</h1>
            <p>Your instructors are preparing the curriculum. Check back shortly.</p>
          </div>
        </section>
      </div>
    );
  }

  const [completedLessonIds, activeLessonId] = await Promise.all([
    getCompletedLessonIds(account.id),
    getInProgressLessonId(account.id),
  ]);

  return (
    <div className="member-page course-page">
      <CourseMap
        activeLessonId={activeLessonId}
        completedLessonIds={completedLessonIds}
        course={{
          title: course.title,
          stages: course.stages.map((stage) => ({
            id: stage.id,
            number: stage.number,
            title: stage.title,
            shortTitle: stage.shortTitle,
            lessons: stage.lessons.map((lesson) => ({
              id: lesson.id,
              number: lesson.number,
              title: lesson.title,
              durationMinutes: lesson.durationMinutes,
            })),
          })),
        }}
      />
    </div>
  );
}
