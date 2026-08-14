import { WorkflowBoard } from "@/features/implementation/workflow-board";
import { ProductionMemberAccess } from "@/components/production-member-access";
import { isDemoMode } from "@/lib/config/mode";
import { demoArtifacts } from "@/lib/demo/data";

export default function WorkflowsPage() {
  if (!isDemoMode()) return <ProductionMemberAccess />;
  const workflows = demoArtifacts.find((artifact) => artifact.kind === "workflow_portfolio")?.workflows ?? [];
  return <div className="member-page workflows-page"><section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Implementation registry</span><h1>Your business workflows</h1><p>Every workflow has an owner, safety rule, human review point, and measurable target.</p></div></section><WorkflowBoard initialWorkflows={workflows} /></div>;
}
