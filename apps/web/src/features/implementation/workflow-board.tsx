"use client";

import { useState, useTransition } from "react";
import { ArrowRight, CirclePause, Plus, ShieldCheck, UserRound } from "lucide-react";
import type { WorkflowStatus } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { createWorkflowAction, saveWorkflowAction, setWorkflowStatusAction } from "@/app/learn/actions";

export type BoardWorkflow = {
  id: string;
  name: string;
  engine: "growth" | "client" | "management";
  problem: string;
  owner: string;
  approvedTools: string[];
  humanReviewPoint: string;
  baseline: string;
  target: string;
  status: WorkflowStatus;
};

const statusOrder: WorkflowStatus[] = ["draft", "testing", "live", "paused"];
const statusLabels: Record<WorkflowStatus, string> = { draft: "Draft", testing: "Testing", live: "Live", paused: "Paused" };

function nextStatus(status: WorkflowStatus) {
  return statusOrder[Math.min(statusOrder.indexOf(status) + 1, statusOrder.length - 1)];
}

export function WorkflowBoard({ initialWorkflows }: { initialWorkflows: BoardWorkflow[] }) {
  const [workflows, setWorkflows] = useState(initialWorkflows);
  const [creating, setCreating] = useState(false);
  const [pending, startTransition] = useTransition();

  function advance(workflow: BoardWorkflow) {
    const status = workflow.status === "live" ? "paused" : nextStatus(workflow.status);
    setWorkflows((items) => items.map((item) => item.id === workflow.id ? { ...item, status } : item));
    startTransition(async () => {
      await setWorkflowStatusAction(workflow.id, status);
    });
  }

  function resume(workflowId: string) {
    setWorkflows((items) => items.map((item) => item.id === workflowId ? { ...item, status: "testing" } : item));
    startTransition(async () => {
      await setWorkflowStatusAction(workflowId, "testing");
    });
  }

  return (
    <div className="workflow-board">
      <div className="workflow-toolbar">
        <div><strong>{workflows.filter((item) => item.status === "live").length} live</strong><span>of 3 required workflows</span></div>
        <Button onClick={() => setCreating(true)} size="small" type="button"><Plus size={14} /> New workflow</Button>
      </div>
      {creating ? (
        <form
          action={(formData) => {
            startTransition(async () => {
              await createWorkflowAction(formData);
              setCreating(false);
            });
          }}
          className="workflow-create"
        >
          <label>Name<input name="name" placeholder="Instant lead response" required /></label>
          <label>Engine
            <select defaultValue="growth" name="engine">
              <option value="growth">Growth</option>
              <option value="client">Client</option>
              <option value="management">Management</option>
            </select>
          </label>
          <Button disabled={pending} size="small" type="submit">Create workflow</Button>
        </form>
      ) : null}
      {workflows.length === 0 ? <p className="empty-note">Create your first workflow to start the launch portfolio.</p> : null}
      <div className="workflow-grid">
        {workflows.map((workflow) => {
          const next = nextStatus(workflow.status);
          return (
            <article className={`workflow-card ${workflow.engine}`} key={workflow.id}>
              <div className="workflow-card-head"><span>{workflow.engine} engine</span><i className={`status-pill ${workflow.status}`}>{statusLabels[workflow.status]}</i></div>
              <form action={saveWorkflowAction} className="workflow-edit">
                <input name="workflowId" type="hidden" value={workflow.id} />
                <label>Name<input defaultValue={workflow.name} name="name" required /></label>
                <label>Problem<textarea defaultValue={workflow.problem} name="problem" placeholder="What is slow, inconsistent, or risky today?" rows={3} /></label>
                <dl>
                  <div>
                    <dt id={`${workflow.id}-owner`}><UserRound size={13} /> Owner</dt>
                    <dd><input aria-labelledby={`${workflow.id}-owner`} defaultValue={workflow.owner} name="owner" /></dd>
                  </div>
                  <div>
                    <dt id={`${workflow.id}-review`}><ShieldCheck size={13} /> Human check</dt>
                    <dd><input aria-labelledby={`${workflow.id}-review`} defaultValue={workflow.humanReviewPoint} name="humanReviewPoint" /></dd>
                  </div>
                </dl>
                <div className="workflow-metric">
                  <label>Baseline<input defaultValue={workflow.baseline} name="baseline" placeholder="Current measure" /></label>
                  <ArrowRight size={15} />
                  <label>Target<input defaultValue={workflow.target} name="target" placeholder="Target measure" /></label>
                </div>
                <label>Approved tools<input defaultValue={workflow.approvedTools.join(", ")} name="approvedTools" placeholder="HighLevel, Gmail" /></label>
                <Button disabled={pending} size="small" type="submit" variant="secondary">Save workflow</Button>
              </form>
              {workflow.status !== "paused" ? (
                <Button aria-label={`Move ${workflow.name} to ${statusLabels[next]}`} disabled={pending} onClick={() => advance(workflow)} size="small" variant="secondary">
                  {workflow.status === "live" ? <CirclePause size={14} /> : <ArrowRight size={14} />} {workflow.status === "live" ? "Pause workflow" : `Move to ${statusLabels[next].toLowerCase()}`}
                </Button>
              ) : (
                <Button aria-label={`Resume ${workflow.name}`} disabled={pending} onClick={() => resume(workflow.id)} size="small" variant="secondary">Resume testing</Button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
