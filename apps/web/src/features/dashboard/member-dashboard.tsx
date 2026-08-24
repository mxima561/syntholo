import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Route } from "next";
import { DashboardContinueCard } from "./dashboard-continue-card";
import { DashboardRecommendationCard } from "./dashboard-recommendation-card";
import { DashboardRightRail } from "./dashboard-right-rail";

export type DashboardLesson = {
  id: string;
  title: string;
  summary: string;
  actionLabel: string;
  stageTitle?: string;
};

export type DashboardRecommendation = {
  label: string;
  title: string;
  description: string;
  href: Route;
  actionLabel: string;
  tone: "coral" | "gold";
};

type MemberDashboardProps = {
  workspaceName: string;
  progressPercent: number;
  nextLesson: DashboardLesson | null;
  nextHref: Route;
  coachThread: { subject: string; coachFirstName: string; lastMessage: string };
  upcomingSession: { title: string; hostName: string; region: string } | null;
  recommendations: DashboardRecommendation[];
  priorities: string[];
  publicId: string;
  certificateHref?: Route | null;
};

export function MemberDashboard({
  workspaceName,
  progressPercent,
  nextLesson,
  nextHref,
  coachThread,
  upcomingSession,
  recommendations,
  priorities,
  publicId,
  certificateHref,
}: MemberDashboardProps) {
  return (
    <div className="member-page member-dashboard">
      <section className="dashboard-heading">
        <div>
          <span className="meta-label">{workspaceName} · Student ID {publicId}</span>
          <h1>Keep building your business OS.</h1>
          <p>One focused action, a practical recommendation, and a real person in your corner.</p>
        </div>
        <div className="dashboard-heading-links">
          <Link className="text-link" href="/learn/course">Browse lessons and templates <ArrowRight size={14} /></Link>
          {certificateHref ? <Link className="text-link" href={certificateHref}>View certificate <ArrowRight size={14} /></Link> : null}
        </div>
      </section>

      <div className="dashboard-layout">
        <div className="dashboard-main">
          {nextLesson ? (
            <DashboardContinueCard href={nextHref} lesson={nextLesson} progressPercent={progressPercent} />
          ) : (
            <article className="dashboard-continue-card">
              <div className="dashboard-continue-copy">
                <span className="meta-label">Course complete</span>
                <h2>You finished the required lessons.</h2>
                <p>Keep the 30-day outputs current and launch the remaining workflows.</p>
                <Link className="button button-primary button-medium" href="/learn/plan">Open 30-day plan</Link>
              </div>
            </article>
          )}
          <section className="dashboard-recommendation-section" aria-labelledby="recommendations-heading">
            <div className="dashboard-section-heading">
              <span className="meta-label">Keep momentum</span>
              <h2 id="recommendations-heading">Recommended next</h2>
            </div>
            <div className="dashboard-recommendations">
              {recommendations.map((recommendation) => (
                <DashboardRecommendationCard key={recommendation.title} {...recommendation} />
              ))}
            </div>
          </section>
        </div>
        <DashboardRightRail
          priorities={priorities}
          coachThread={coachThread}
          session={upcomingSession}
        />
      </div>
    </div>
  );
}
