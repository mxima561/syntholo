import Link from "next/link";
import { ArrowRight, Check, Clock3, LockKeyhole, Play } from "lucide-react";
import { requireStudentAccount } from "@/lib/server/accounts";
import { getCompletedLessonIds, getInProgressLessonId, getPrimaryCourse } from "@/lib/server/courses";

export const dynamic = "force-dynamic";

export default async function CourseMapPage() {
  const account = await requireStudentAccount();
  const course = await getPrimaryCourse();

  if (!course) {
    return (
      <div className="member-page course-page">
        <section className="page-intro"><div><h1>No published course yet</h1><p>Your instructors are preparing the curriculum. Check back shortly.</p></div></section>
      </div>
    );
  }

  const [completedLessonIds, activeLessonId] = await Promise.all([
    getCompletedLessonIds(account.id),
    getInProgressLessonId(account.id),
  ]);
  const totalLessons = course.stages.reduce((sum, stage) => sum + stage.lessons.length, 0);

  return (
    <div className="member-page course-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" /> Practical curriculum</span>
          <h1>{course.title}</h1>
          <p>{course.description}</p>
        </div>
        <div className="course-summary"><strong>{completedLessonIds.length}</strong><span>of {totalLessons} lessons complete</span></div>
      </section>
      <div className="course-stage-list">
        {course.stages.map((stage) => (
          <section className="course-stage" key={stage.id}>
            <div className="stage-intro"><span>STAGE {String(stage.number).padStart(2, "0")}</span><h2>{stage.title}</h2><p>{stage.description}</p><small>Release week {stage.releaseWeek}</small></div>
            <div className="stage-lessons">
              {stage.lessons.map((lesson) => {
                const complete = completedLessonIds.includes(lesson.id);
                const active = lesson.id === activeLessonId;
                return <Link className={active ? "active" : ""} href={`/learn/course/${lesson.id}`} key={lesson.id}><span className={`lesson-state ${complete ? "complete" : active ? "active" : ""}`}>{complete ? <Check size={14} /> : active ? <Play fill="currentColor" size={12} /> : lesson.number}</span><div><small>Lesson {lesson.number}</small><strong>{lesson.title}</strong><p>{lesson.summary}</p></div><span className="lesson-duration"><Clock3 size={13} /> {lesson.durationMinutes} min</span>{stage.releaseWeek > 4 ? <LockKeyhole size={13} /> : <ArrowRight size={15} />}</Link>;
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
