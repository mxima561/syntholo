import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { DashboardView } from "@/lib/demo/repository";
import { DashboardIllustration } from "./dashboard-illustration";

type DashboardContinueCardProps = {
  href: DashboardView["nextAction"]["href"];
  lesson: DashboardView["nextLesson"];
  progressPercent: number;
};

export function DashboardContinueCard({ href, lesson, progressPercent }: DashboardContinueCardProps) {
  return (
    <article className="dashboard-continue-card">
      <DashboardIllustration />
      <div className="dashboard-continue-copy">
        <span className="meta-label">Stage 3 · Growth engine</span>
        <h2>{lesson.title}</h2>
        <p>{lesson.summary}</p>
        <Progress label="Program completion" showValue value={progressPercent} />
        <Button href={href}>Resume lesson</Button>
      </div>
    </article>
  );
}
