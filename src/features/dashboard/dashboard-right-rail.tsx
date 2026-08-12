import Link from "next/link";
import { ArrowRight, CalendarDays, MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DashboardView } from "@/lib/demo/repository";

type DashboardRightRailProps = {
  actionLabel: string;
  policyTitle: string;
  workflowName: string;
  thread: DashboardView["supportThreads"][number];
  session: NonNullable<DashboardView["upcomingSession"]>;
};

export function DashboardRightRail({ actionLabel, policyTitle, workflowName, thread, session }: DashboardRightRailProps) {
  const reply = thread.messages.at(-1);

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
        <span className="meta-label">Naomi replied</span>
        <h2>{thread.subject}</h2>
        <p>“{reply?.body}”</p>
        <Button href={`/learn/support?thread=${thread.id}`} size="small" variant="human">
          Ask a coach <MessageSquareText size={14} />
        </Button>
      </section>
      <section className="dashboard-rail-card dashboard-session-card">
        <span className="meta-label">Upcoming live session</span>
        <h2>{session.title}</h2>
        <p>Hosted by {session.hostName} · {session.region}</p>
        <Link className="text-link" href="/learn/live">View session <CalendarDays size={14} /><ArrowRight size={14} /></Link>
      </section>
    </aside>
  );
}
