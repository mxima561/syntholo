import { WorkflowBoard } from "@/features/implementation/workflow-board";
import { requireStudentAccount } from "@/lib/server/accounts";
import { listWorkflows } from "@syntholo/db";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const account = await requireStudentAccount();
  const workflows = await listWorkflows(account.id);
  return (
    <div className="member-page workflows-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" /> Implementation registry</span>
          <h1>Your business workflows</h1>
          <p>Every workflow has an owner, safety rule, human review point, and measurable target. Status changes are saved to your account.</p>
        </div>
      </section>
      <WorkflowBoard initialWorkflows={workflows} />
    </div>
  );
}
