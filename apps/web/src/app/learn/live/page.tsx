import { LiveSchedule } from "@/features/live/live-schedule";
import { demoSessions } from "@/lib/demo/data";

export default function LivePage() {
  return <div className="member-page live-page"><section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Human-led learning</span><h1>Live sessions</h1><p>Bring the real workflow you are building. Leave with a specific decision and next action.</p></div></section><LiveSchedule sessions={demoSessions} /></div>;
}
