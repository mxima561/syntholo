import { CalendarDays, MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DashboardView } from "@/lib/demo/repository";

type DashboardRightRailProps = {
  actionLabel: string;
  policyTitle: string;
  workflowName: string;
  coachThread: { subject: string; coachFirstName: string; lastMessage: string };
  session: NonNullable<DashboardView["upcomingSession"]>;
};

export function DashboardRightRail({ actionLabel, policyTitle, workflowName, coachThread, session }: DashboardRightRailProps) {
  return (
    <aside className="dashboard-right-rail" aria-label="Member support and priorities">
      <section className="dashboard-rail-card dashboard-priorities-card">
        <span className="meta-label">This week</span>
        <h2>Weekly priorities</h2>
        <ul>
          <li>{actionLabel}</li>
          <li>{policyTitle}</li>
          <li>{workflowName}</li>
        </ul>
      </section>
      <section className="dashboard-rail-card dashboard-coach-card">
        <span className="meta-label">{coachThread.coachFirstName} said</span>
        <h2>{coachThread.subject}</h2>
        <p>“{coachThread.lastMessage}”</p>
        <Button href="/learn/support" size="small" variant="human">
          Ask a coach <MessageSquareText size={14} />
        </Button>
      </section>
      <section className="dashboard-rail-card dashboard-session-card">
        <span className="meta-label">Upcoming live session</span>
        <h2>{session.title}</h2>
        <p>Hosted by {session.hostName} · {session.region}</p>
        <Button href="/learn/live" size="small" variant="milestone">
          View session <CalendarDays size={14} />
        </Button>
      </section>
    </aside>
  );
}
