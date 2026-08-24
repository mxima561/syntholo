import { requireStaff } from "@/lib/auth/staff";
import { getAdminOverview } from "@/lib/server/courses";
import { listScorecards, listSoftwareAccounts, listActivityEvents } from "@syntholo/db";
import { listAllThreads } from "@/lib/server/support";

export const dynamic = "force-dynamic";

export default async function AdminAnalyticsPage() {
  await requireStaff();
  const [overview, scorecards, software, threads, events] = await Promise.all([
    getAdminOverview(),
    listScorecards(200),
    listSoftwareAccounts(),
    listAllThreads(),
    listActivityEvents({ limit: 20 }),
  ]);
  const openSupport = threads.filter((thread) => thread.status === "new" || thread.status === "waiting_on_coach").length;

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Product intelligence</span>
          <h1>Analytics</h1>
          <p>Live counts from Postgres — not demo fixtures.</p>
        </div>
      </section>
      <section className="admin-metric-grid">
        <article><div><small>Students</small><strong>{overview.studentCount}</strong><i>{overview.activeLearners} active learners</i></div></article>
        <article><div><small>Lesson completions</small><strong>{overview.completions}</strong><i>{overview.publishedLessons} published lessons</i></div></article>
        <article><div><small>Scorecards</small><strong>{scorecards.length}</strong><i>Saved readiness reports</i></div></article>
        <article><div><small>Open support</small><strong>{openSupport}</strong><i>{software.filter((item) => item.status === "provisioning").length} Business OS in progress</i></div></article>
      </section>
      <section className="admin-table">
        <header><span>Recent event</span><span>Actor</span><span>When</span><span>Action</span><span /></header>
        {events.map((event) => (
          <div className="student-row" key={event.id}>
            <strong>{event.summary}</strong>
            <span>{event.actorPublicId ?? event.actorLabel}</span>
            <span>{event.createdAt.toLocaleString("en-US")}</span>
            <code>{event.action}</code>
            <span />
          </div>
        ))}
      </section>
    </div>
  );
}
