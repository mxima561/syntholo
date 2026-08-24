import Link from "next/link";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { createLessonAction, deleteLessonAction, setCourseStatusAction, toggleLessonPublishAction, updateStageAction } from "@/app/actions";
import { requireStaff } from "@/lib/auth/staff";
import { getPrimaryCourse } from "@/lib/server/courses";

export const dynamic = "force-dynamic";

export default async function AdminContentPage() {
  await requireStaff("content");
  const course = await getPrimaryCourse(true);

  if (!course) {
    return (
      <div className="admin-page">
        <section className="admin-page-head"><div><h1>Course content</h1><p>No courses exist yet.</p></div></section>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Structured editor</span>
          <h1>Course content</h1>
          <p>Manage stages, lessons, video links, and publication — saved to your database instantly.</p>
        </div>
      </section>

      <section className="content-editor-panel">
        <header>
          <div>
            <span className={`status-pill ${course.status === "published" ? "live" : ""}`}>{course.status === "published" ? "Published" : "Draft"}</span>
            <h2>{course.title}</h2>
            <p>Updated {new Date(course.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
          </div>
          <form action={setCourseStatusAction}>
            <input name="courseId" type="hidden" value={course.id} />
            <input name="status" type="hidden" value={course.status === "published" ? "draft" : "published"} />
            <button className={`button ${course.status === "published" ? "button-secondary" : "button-primary"} button-small`} type="submit">
              {course.status === "published" ? "Unpublish course" : "Publish course"}
            </button>
          </form>
        </header>

        <div className="content-stage-list">
          {course.stages.map((stage) => (
            <section key={stage.id}>
              <details className="stage-editor">
                <summary>
                  <span>0{stage.number}</span>
                  <div><strong>{stage.title}</strong><small>{stage.lessons.length} lessons · Release week {stage.releaseWeek}</small></div>
                </summary>
                <form action={updateStageAction} className="stage-editor-form">
                  <input name="stageId" type="hidden" value={stage.id} />
                  <label>Title<input defaultValue={stage.title} name="title" required /></label>
                  <label>Short title<input defaultValue={stage.shortTitle} name="shortTitle" /></label>
                  <label>Description<textarea defaultValue={stage.description} name="description" rows={2} /></label>
                  <button className="button button-secondary button-small" type="submit">Save stage</button>
                </form>
              </details>

              {stage.lessons.map((lesson) => (
                <article key={lesson.id}>
                  <span>{lesson.number}</span>
                  <div>
                    <Link href={`/content/${lesson.id}`}><strong>{lesson.title}</strong></Link>
                    <small>{lesson.videoUrl ? "Video linked · " : "No video yet · "}{lesson.resourceCount} resources</small>
                  </div>
                  <i>{lesson.durationMinutes} min</i>
                  <form action={toggleLessonPublishAction}>
                    <input name="lessonId" type="hidden" value={lesson.id} />
                    <input name="isPublished" type="hidden" value={lesson.isPublished ? "false" : "true"} />
                    <button aria-label={lesson.isPublished ? `Unpublish ${lesson.title}` : `Publish ${lesson.title}`} className="icon-button" type="submit">
                      {lesson.isPublished ? <Eye size={15} /> : <EyeOff size={15} />}
                    </button>
                  </form>
                  <span className={`status-pill ${lesson.isPublished ? "live" : ""}`}>{lesson.isPublished ? "Live" : "Draft"}</span>
                  <Link className="button button-secondary button-small" href={`/content/${lesson.id}`}>Edit</Link>
                  <form action={deleteLessonAction}>
                    <input name="lessonId" type="hidden" value={lesson.id} />
                    <button aria-label={`Delete ${lesson.title}`} className="icon-button danger" type="submit"><Trash2 size={15} /></button>
                  </form>
                </article>
              ))}

              <form action={createLessonAction} className="inline-create">
                <input name="courseId" type="hidden" value={course.id} />
                <input name="stageId" type="hidden" value={stage.id} />
                <input aria-label="New lesson title" name="title" placeholder="New lesson title…" required />
                <button className="button button-primary button-small" type="submit"><Plus size={14} /> Add lesson</button>
              </form>
            </section>
          ))}
        </div>
        <footer><Eye size={14} /> Draft lessons are hidden from students until you publish them.</footer>
      </section>
    </div>
  );
}
