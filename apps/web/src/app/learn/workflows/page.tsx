import { ProductionMemberAccess } from "@/components/production-member-access";
import { isDemoMode } from "@/lib/config/mode";

export default async function WorkflowsPage() {
  if (!isDemoMode()) return <ProductionMemberAccess />;
  const [{ WorkflowBoard }, { demoArtifacts }] = await Promise.all([
    import("@/features/implementation/workflow-board"),
    import("@/lib/demo/data"),
  ]);
  const workflows = demoArtifacts.find((artifact) => artifact.kind === "workflow_portfolio")?.workflows ?? [];
  return <div className="member-page workflows-page"><section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Implementation registry</span><h1>Your business workflows</h1><p>Every workflow has an owner, safety rule, human review point, and measurable target.</p></div></section><WorkflowBoard initialWorkflows={workflows} /></div>;
}
