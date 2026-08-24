import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { deleteLessonAction, updateLessonAction } from "@/app/actions";
import { requireStaff } from "@/lib/auth/staff";
import { getLessonById, getPrimaryCourse } from "@/lib/server/courses";

export const dynamic = "force-dynamic";

export default async function LessonEditorPage({ params }: { params: Promise<{ lessonId: string }> }) {
  await requireStaff("content");
  const { lessonId } = await params;
  const [lesson, course] = await Promise.all([getLessonById(lessonId, true), getPrimaryCourse(true)]);
  if (!lesson || !course) notFound();

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <Link className="text-link" href="/content"><ArrowLeft size={14} /> Back to course content</Link>
          <h1>Edit lesson</h1>
          <p>Changes save to the database immediately. Students see updates on their next page load.</p>
        </div>
        <form action={deleteLessonAction}>
          <input name="lessonId" type="hidden" value={lesson.id} />
          <button className="button button-secondary button-small" type="submit">Delete lesson</button>
        </form>
      </section>

      <section className="content-editor-panel">
        <header><div><span className={`status-pill ${lesson.isPublished ? "live" : ""}`}>{lesson.isPublished ? "Live" : "Draft"}</span><h2>{lesson.title}</h2></div></header>
        <form action={updateLessonAction} className="lesson-editor-form">
          <input name="lessonId" type="hidden" value={lesson.id} />

          <div className="form-row">
            <label>Lesson title<input defaultValue={lesson.title} name="title" required /></label>
            <label>
              Stage
              <select defaultValue={lesson.stageId} name="stageId">
                {course.stages.map((stage) => <option key={stage.id} value={stage.id}>{String(stage.number).padStart(2, "0")} · {stage.title}</option>)}
              </select>
            </label>
          </div>

          <label>Summary<textarea defaultValue={lesson.summary} name="summary" rows={2} /></label>
          <label>Action label — do this in your business<input defaultValue={lesson.actionLabel} name="actionLabel" /></label>

          <div className="form-row">
            <label>Video URL (YouTube, Vimeo, or MP4)<input defaultValue={lesson.videoUrl ?? ""} name="videoUrl" placeholder="https://youtube.com/watch?v=…" type="url" /></label>
            <div className="form-pair">
              <label>Duration (minutes)<input defaultValue={lesson.durationMinutes} min={1} name="durationMinutes" type="number" /></label>
              <label>Resource count<input defaultValue={lesson.resourceCount} min={0} name="resourceCount" type="number" /></label>
            </div>
          </div>

          <label>Transcript (blank line between paragraphs)<textarea defaultValue={lesson.transcript.join("\n\n")} name="transcript" rows={8} /></label>

          <label className="checkbox-label">
            <input defaultChecked={lesson.isPublished} name="isPublished" type="checkbox" />
            Published — visible to students
          </label>

          <div className="editor-footer">
            <button className="button button-primary" type="submit">Save changes</button>
          </div>
        </form>
      </section>
    </div>
  );
}
