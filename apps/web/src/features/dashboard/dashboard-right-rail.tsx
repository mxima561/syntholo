import { CalendarDays, MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";

type DashboardRightRailProps = {
  priorities: string[];
  coachThread: { subject: string; coachFirstName: string; lastMessage: string };
  session: { title: string; hostName: string; region: string } | null;
};

export function DashboardRightRail({ priorities, coachThread, session }: DashboardRightRailProps) {
  return (
    <aside className="dashboard-right-rail" aria-label="Member support and priorities">
      <section className="dashboard-rail-card dashboard-priorities-card">
        <span className="meta-label">This week</span>
        <h2>Weekly priorities</h2>
        <ul>
          {priorities.map((item) => <li key={item}>{item}</li>)}
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
        {session ? (
          <>
            <h2>{session.title}</h2>
            <p>Hosted by {session.hostName} · {session.region}</p>
          </>
        ) : (
          <>
            <h2>Office hours</h2>
            <p>Reserve a seat when the next session is published.</p>
          </>
        )}
        <Button href="/learn/live" size="small" variant="milestone">
          View session <CalendarDays size={14} />
        </Button>
      </section>
    </aside>
  );
}
