import { requireStudentAccount } from "@/lib/server/accounts";
import { getPrimaryCourse, getCompletedLessonIds } from "@/lib/server/courses";
import { getCertificate } from "@syntholo/db";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CertificatePage() {
  const account = await requireStudentAccount();
  const course = await getPrimaryCourse();
  if (!course) notFound();
  const certificate = await getCertificate(account.id, course.id);
  const completed = await getCompletedLessonIds(account.id);
  if (!certificate) {
    return (
      <div className="member-page simple-page">
        <span className="eyebrow"><span className="eyebrow-dot" /> Progress</span>
        <h1>Certificate</h1>
        <p>Complete every required published lesson to receive your unaccredited completion certificate. {completed.length} lessons recorded so far.</p>
      </div>
    );
  }

  const name = `${account.firstName} ${account.lastName}`.trim() || account.email;
  return (
    <div className="member-page simple-page certificate-page">
      <span className="eyebrow"><span className="eyebrow-dot" /> Completion</span>
      <h1>Certificate of completion</h1>
      <section className="certificate-card">
        <span className="micro-label">Syntholo Academy</span>
        <h2>{course.title}</h2>
        <p>This certifies that</p>
        <strong>{name}</strong>
        <p>completed the required published lessons on {certificate.issuedAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.</p>
        <small>Student ID {account.publicId} · Certificate {certificate.id.slice(0, 8).toUpperCase()} · Unaccredited progress achievement</small>
      </section>
    </div>
  );
}
