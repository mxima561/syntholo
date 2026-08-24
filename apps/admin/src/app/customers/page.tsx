import { Search } from "lucide-react";
import Link from "next/link";
import { grantEntitlementAction, refundPurchaseAction, revokeEntitlementAction } from "@/app/actions";
import { requireStaff } from "@/lib/auth/staff";
import { getPrimaryCourse, listStudents } from "@/lib/server/courses";
import { listPaidPurchases } from "@syntholo/db";
import { CopyId } from "@/components/copy-id";

export const dynamic = "force-dynamic";

export default async function AdminStudentsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireStaff();
  const { q } = await searchParams;
  const [students, course, purchases] = await Promise.all([listStudents(), getPrimaryCourse(true), listPaidPurchases(100)]);
  const totalLessons = course?.stages.reduce((sum, stage) => sum + stage.lessons.length, 0) ?? 0;
  const courseId = course?.id ?? "";

  const query = q?.trim().toLowerCase();
  const filtered = query
    ? students.filter((student) =>
        `${student.publicId} ${student.id} ${student.firstName} ${student.lastName} ${student.email} ${student.businessName}`.toLowerCase().includes(query))
    : students;

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Student operations</span>
          <h1>Students</h1>
          <p>Every academy member has a stable student ID (STU-…). Search by ID, email, or name. Staff access is managed separately under Staff.</p>
        </div>
        <form className="admin-search" method="get">
          <Search size={14} />
          <span className="sr-only">Search students</span>
          <input aria-label="Search students by ID, name, or email" defaultValue={q} name="q" placeholder="Search ID, name, or email" />
        </form>
      </section>

      <section className="admin-table students-table">
        <header><span>Student ID</span><span>Student</span><span>Email</span><span>Progress</span><span>Joined</span><span>Access</span></header>
        {filtered.length === 0 ? (
          <p className="empty-note">No students found{query ? ` for “${q}”` : ""}.</p>
        ) : (
          filtered.map((student) => (
            <div className="student-row student-row-ids" key={student.id}>
              <CopyId value={student.publicId} />
              <div>
                <Link href={`/customers/${student.id}`}>
                  <strong>{[student.firstName, student.lastName].filter(Boolean).join(" ") || "—"}</strong>
                </Link>
                {student.businessName ? <small>{student.businessName}</small> : null}
              </div>
              <span>{student.email}</span>
              <span>{totalLessons > 0 ? `${Math.round((student.completedLessons / totalLessons) * 100)}%` : "—"}<small> ({student.completedLessons}/{totalLessons})</small></span>
              <span>{new Date(student.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
              <div>
                {courseId ? (
                  <>
                    <form action={grantEntitlementAction}>
                      <input name="userId" type="hidden" value={student.id} />
                      <input name="courseId" type="hidden" value={courseId} />
                      <button className="button button-secondary button-small" type="submit">Grant course</button>
                    </form>
                    <form action={revokeEntitlementAction}>
                      <input name="userId" type="hidden" value={student.id} />
                      <input name="courseId" type="hidden" value={courseId} />
                      <button className="button button-secondary button-small" type="submit">Revoke course</button>
                    </form>
                  </>
                ) : null}
              </div>
            </div>
          ))
        )}
      </section>

      <section className="admin-table">
        <header><span>Purchase ID</span><span>Email</span><span>Offer</span><span>Status</span><span /></header>
        {purchases.length === 0 ? (
          <p className="empty-note">No purchases yet.</p>
        ) : purchases.map((purchase) => (
          <div className="student-row" key={purchase.id}>
            <CopyId value={purchase.id} label={purchase.id.slice(0, 8)} />
            <span>{purchase.email}</span>
            <span>{purchase.offer}</span>
            <i className={`status-pill ${purchase.status === "paid" ? "live" : ""}`}>{purchase.status}</i>
            {purchase.status === "paid" ? (
              <form action={refundPurchaseAction}>
                <input name="purchaseId" type="hidden" value={purchase.id} />
                <button className="button button-secondary button-small" type="submit">Refund</button>
              </form>
            ) : <span />}
          </div>
        ))}
      </section>
    </div>
  );
}
