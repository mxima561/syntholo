import { ProductionMemberAccess } from "@/components/production-member-access";
import { isDemoMode } from "@/lib/config/mode";

export default async function LivePage() {
  if (!isDemoMode()) return <ProductionMemberAccess />;
  const [{ LiveSchedule }, { demoSessions }] = await Promise.all([
    import("@/features/live/live-schedule"),
    import("@/lib/demo/data"),
  ]);
  return <div className="member-page live-page"><section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Human-led learning</span><h1>Live sessions</h1><p>Bring the real workflow you are building. Leave with a specific decision and next action.</p></div></section><LiveSchedule sessions={demoSessions} /></div>;
}
