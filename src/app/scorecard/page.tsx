import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ScorecardClient } from "@/features/scorecard/scorecard-client";

export const metadata = {
  title: "AI Business Readiness Scorecard",
  description: "Find your strongest AI opportunity and the safest place to begin.",
};

export default function ScorecardPage() {
  return (
    <main className="scorecard-page">
      <header className="scorecard-header">
        <Link className="brand" href="/"><span className="brand-mark">S</span><span>Syntholo</span></Link>
        <Link className="text-link" href="/"><ArrowLeft aria-hidden size={15} /> Back to Syntholo</Link>
      </header>
      <ScorecardClient />
    </main>
  );
}

