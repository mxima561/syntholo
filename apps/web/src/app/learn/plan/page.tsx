import { ProductionMemberAccess } from "@/components/production-member-access";
import { isDemoMode } from "@/lib/config/mode";

export default async function PlanPage() {
  if (!isDemoMode()) return <ProductionMemberAccess />;
  const [{ ImplementationPlan }, { demoArtifacts }] = await Promise.all([
    import("@/features/implementation/implementation-plan"),
    import("@/lib/demo/data"),
  ]);
  return <div className="member-page plan-page"><section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Guided implementation</span><h1>Your 30-day build plan</h1><p>Lessons teach the method. This workspace turns it into an operating system your team owns.</p></div></section><ImplementationPlan initialArtifacts={demoArtifacts} /></div>;
}
