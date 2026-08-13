import { ImplementationPlan } from "@/features/implementation/implementation-plan";
import { demoArtifacts } from "@/lib/demo/data";

export default function PlanPage() {
  return <div className="member-page plan-page"><section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Guided implementation</span><h1>Your 30-day build plan</h1><p>Lessons teach the method. This workspace turns it into an operating system your team owns.</p></div></section><ImplementationPlan initialArtifacts={demoArtifacts} /></div>;
}
