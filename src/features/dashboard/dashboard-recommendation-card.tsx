import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Route } from "next";

type DashboardRecommendationCardProps = {
  label: string;
  title: string;
  description: string;
  href: Route;
  actionLabel: string;
  tone: "coral" | "gold";
};

export function DashboardRecommendationCard({
  label,
  title,
  description,
  href,
  actionLabel,
  tone,
}: DashboardRecommendationCardProps) {
  return (
    <article className={`dashboard-recommendation dashboard-recommendation-${tone}`} data-testid="dashboard-recommendation">
      <span className="meta-label">{label}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      <Link className="text-link" href={href}>{actionLabel} <ArrowRight size={14} /></Link>
    </article>
  );
}
