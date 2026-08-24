import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { Route } from "next";
import { DashboardIllustration } from "./dashboard-illustration";
import type { DashboardLesson } from "./member-dashboard";

type DashboardContinueCardProps = {
  href: Route;
  lesson: DashboardLesson;
  progressPercent: number;
};

export function DashboardContinueCard({ href, lesson, progressPercent }: DashboardContinueCardProps) {
  return (
    <article className="dashboard-continue-card">
      <DashboardIllustration />
      <div className="dashboard-continue-copy">
        <span className="meta-label">{lesson.stageTitle ?? "Course"}</span>
        <h2>{lesson.title}</h2>
        <p>{lesson.summary}</p>
        <Progress label="Program completion" showValue value={progressPercent} />
        <Button href={href}>Resume lesson</Button>
      </div>
    </article>
  );
}
