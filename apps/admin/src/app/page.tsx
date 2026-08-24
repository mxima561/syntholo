import { AlertTriangle, ArrowRight, BookOpenCheck, Clock3, GraduationCap, UsersRound } from "lucide-react";
import Link from "next/link";
import { requireStaff, staffDisplayName } from "@/lib/auth/staff";
import { getAdminOverview } from "@/lib/server/courses";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const staff = await requireStaff();
  const overview = await getAdminOverview();

  const firstName = staffDisplayName(staff);
  const avgPerLearner = overview.activeLearners > 0
    ? Math.round(overview.completions / overview.activeLearners)
    : 0;

  const metrics = [
    { label: "Enrolled students", value: String(overview.studentCount), change: `${overview.adminCount} admins`, icon: UsersRound },
    { label: "Lessons published", value: `${overview.publishedLessons}/${overview.totalLessons}`, change: overview.publishedLessons < overview.totalLessons ? "Drafts pending" : "All live", icon: BookOpenCheck },
    { label: "Lesson completions", value: String(overview.completions), change: `~${avgPerLearner}/active learner`, icon: BookOpenCheck },
    { label: "Active learners", value: String(overview.activeLearners), change: "Started at least one lesson", icon: GraduationCap },
  ];

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Live operating brief</span>
          <h1>Welcome back, {firstName}.</h1>
          <p>Everything below is read straight from your Neon Postgres database.</p>
        </div>
      </section>

      <section className="admin-metric-grid">
        {metrics.map((metric) => (
          <article key={metric.label}>
            <span><metric.icon size={17} /></span>
            <div><small>{metric.label}</small><strong>{metric.value}</strong><i>{metric.change}</i></div>
          </article>
        ))}
      </section>

      <div className="admin-dashboard-grid">
        <section className="admin-panel wide-panel">
          <div className="admin-panel-head">
            <div><span className="micro-label">Learning</span><h2>Stage completion</h2></div>
            <Link href="/content">Edit content</Link>
          </div>
          <div className="stage-chart">
            {overview.stageCompletion.map((stage) => {
              const percent = stage.lessonCount > 0 ? Math.min(100, Math.round((stage.completions / (stage.lessonCount * Math.max(overview.studentCount + overview.adminCount, 1))) * 100)) : 0;
              return (
                <div key={stage.stageTitle}>
                  <span>{stage.stageTitle}</span>
                  <i><b style={{ width: `${percent}%` }} /></i>
                  <strong>{stage.completions} done</strong>
                </div>
              );
            })}
          </div>
        </section>

        <section className="admin-panel">
          <div className="admin-panel-head">
            <div><span className="micro-label">Newest members</span><h2>Recent sign-ups</h2></div>
            <Link href="/customers">All students</Link>
          </div>
          {overview.recentStudents.length === 0 ? (
            <p className="empty-note">No sign-ups yet. Share the site and they will appear here.</p>
          ) : (
            overview.recentStudents.map((student) => (
              <div className="recent-row" key={student.id}>
                <strong>{[student.firstName, student.lastName].filter(Boolean).join(" ") || student.email}</strong>
                <small>{new Date(student.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small>
              </div>
            ))
          )}
        </section>

        <section className="admin-panel wide-panel">
          <div className="admin-panel-head">
            <div><span className="micro-label">Momentum</span><h2>Recent completions</h2></div>
          </div>
          {overview.recentCompletions.length === 0 ? (
            <p className="empty-note"><AlertTriangle size={14} /> No completions yet — once students mark lessons done they show up here.</p>
          ) : (
            overview.recentCompletions.map((completion) => (
              <div className="recent-row" key={`${completion.lessonId}-${completion.email}-${completion.completedAt}`}>
                <span><Clock3 size={13} /> {completion.firstName || completion.email} finished <strong>{completion.lessonTitle}</strong></span>
                <small>{completion.completedAt ? new Date(completion.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}</small>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
