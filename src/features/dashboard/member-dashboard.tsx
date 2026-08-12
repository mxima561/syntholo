import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { DashboardView } from "@/lib/demo/repository";
import { DashboardContinueCard } from "./dashboard-continue-card";
import { DashboardRecommendationCard } from "./dashboard-recommendation-card";
import { DashboardRightRail } from "./dashboard-right-rail";

export function MemberDashboard({ dashboard }: { dashboard: DashboardView }) {
  const policy = dashboard.artifacts.find((artifact) => artifact.kind === "ai_policy")!;
  const workflowPortfolio = dashboard.artifacts.find(
    (artifact) => artifact.kind === "workflow_portfolio",
  )!;
  const nextWorkflow = workflowPortfolio.workflows!.find((workflow) => workflow.status !== "live")!;

  const recommendations = [
    {
      label: "Coach feedback",
      title: policy.title,
      description: "Review Naomi's two notes before your next team meeting.",
      href: `/learn/plan?artifact=${policy.id}` as `/learn/plan?artifact=${string}`,
      actionLabel: "Open workspace",
      tone: "coral" as const,
    },
    {
      label: "Workflow",
      title: nextWorkflow.name,
      description: `${nextWorkflow.target}. Complete the next test before launch.`,
      href: "/learn/workflows" as const,
      actionLabel: "Review workflow",
      tone: "gold" as const,
    },
  ];

  return (
    <div className="member-page member-dashboard">
      <section className="dashboard-heading">
        <div>
          <span className="meta-label">Northstar Advisory · Academy</span>
          <h1>Keep building your business OS.</h1>
          <p>One focused action, a practical recommendation, and a real person in your corner.</p>
        </div>
        <Link className="text-link" href="/learn/course">Browse lessons and templates <ArrowRight size={14} /></Link>
      </section>

      <div className="dashboard-layout">
        <div className="dashboard-main">
          <DashboardContinueCard
            href={dashboard.nextAction.href}
            lesson={dashboard.nextLesson}
            progressPercent={dashboard.progressPercent}
          />
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
          actionLabel={dashboard.nextLesson.actionLabel}
          policyTitle={policy.title}
          workflowName={nextWorkflow.name}
          thread={dashboard.supportThreads[0]}
          session={dashboard.upcomingSession!}
        />
      </div>
    </div>
  );
}
