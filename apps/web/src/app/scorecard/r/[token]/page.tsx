import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicScorecardReport } from "@syntholo/db";

export const dynamic = "force-dynamic";

export default async function ScorecardReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const report = await getPublicScorecardReport(token);
  if (!report) notFound();

  return (
    <main className="scorecard-page">
      <header className="scorecard-header">
        <Link className="brand" href="/"><span className="brand-mark">S</span><span>Syntholo</span></Link>
        <Link className="text-link" href="/scorecard"><ArrowLeft aria-hidden size={15} /> Take the scorecard again</Link>
      </header>
      <section className="scorecard-report" aria-labelledby="report-title">
        <span className="micro-label">SAVED READINESS REPORT</span>
        <h1 id="report-title">You are in the {report.band.toLowerCase()} stage.</h1>
        <p>This link expires on {new Date(report.expiresAt).toLocaleDateString("en-US", { dateStyle: "long" })}. It does not include your email or business name.</p>
        <p>Overall score: <strong>{report.overallScore}</strong> / 100</p>
        <Link className="text-link" href="/pricing">See the academy</Link>
      </section>
    </main>
  );
}
