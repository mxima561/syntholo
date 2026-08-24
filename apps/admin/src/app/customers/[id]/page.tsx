import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { getStudentById, getPrimaryCourse } from "@/lib/server/courses";
import { listActivityEvents, listEnrollmentsForUser, listPaidPurchases } from "@syntholo/db";
import { CopyId } from "@/components/copy-id";

export const dynamic = "force-dynamic";

export default async function AdminStudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  const student = await getStudentById(id);
  if (!student) notFound();
  const [course, enrollments, purchases, events] = await Promise.all([
    getPrimaryCourse(true),
    listEnrollmentsForUser(student.id),
    listPaidPurchases(100),
    listActivityEvents({ actorId: student.id, limit: 80 }),
  ]);
  const studentPurchases = purchases.filter((purchase) => purchase.userId === student.id || purchase.email === student.email);
  const totalLessons = course?.stages.reduce((sum, stage) => sum + stage.lessons.length, 0) ?? 0;

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Student record</span>
          <h1>{[student.firstName, student.lastName].filter(Boolean).join(" ") || student.email}</h1>
          <p>{student.email}{student.businessName ? ` · ${student.businessName}` : ""}</p>
        </div>
        <Link className="button button-secondary button-small" href="/customers">All students</Link>
      </section>
      <section className="admin-metric-grid">
        <article><div><small>Student ID</small><strong><CopyId value={student.publicId} /></strong></div></article>
        <article><div><small>Internal UUID</small><strong><CopyId value={student.id} label={`${student.id.slice(0, 8)}…`} /></strong></div></article>
        <article><div><small>Progress</small><strong>{totalLessons ? `${student.completedLessons}/${totalLessons}` : student.completedLessons}</strong></div></article>
        <article><div><small>Enrollments</small><strong>{enrollments.length}</strong></div></article>
      </section>
      <section className="admin-panel wide-panel">
        <div className="admin-panel-head"><div><span className="micro-label">Purchases</span><h2>Commerce on this student</h2></div></div>
        {studentPurchases.length === 0 ? <p className="empty-note">No purchases linked to this email yet.</p> : studentPurchases.map((purchase) => (
          <div className="recent-row" key={purchase.id}><strong>{purchase.offer}</strong><small>{purchase.status} · {purchase.id.slice(0, 8)}</small></div>
        ))}
      </section>
      <section className="admin-table log-table">
        <header><span>When</span><span>Action</span><span>Summary</span><span>Target</span></header>
        {events.length === 0 ? <p className="empty-note">No activity recorded for this student yet.</p> : events.map((event) => (
          <div className="log-row" key={event.id}>
            <time>{event.createdAt.toLocaleString("en-US")}</time>
            <code>{event.action}</code>
            <span>{event.summary}</span>
            <span>{event.targetType} {event.targetId.slice(0, 12)}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
