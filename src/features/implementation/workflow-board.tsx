"use client";

import { useState } from "react";
import { ArrowRight, CirclePause, Plus, ShieldCheck, UserRound } from "lucide-react";
import type { WorkflowRecord, WorkflowStatus } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";

const statusOrder: WorkflowStatus[] = ["draft", "testing", "live", "paused"];
const statusLabels: Record<WorkflowStatus, string> = { draft: "Draft", testing: "Testing", live: "Live", paused: "Paused" };

function nextStatus(status: WorkflowStatus) {
  return statusOrder[Math.min(statusOrder.indexOf(status) + 1, statusOrder.length - 1)];
}

export function WorkflowBoard({ initialWorkflows }: { initialWorkflows: WorkflowRecord[] }) {
  const [workflows, setWorkflows] = useState(initialWorkflows);

  function advance(workflowId: string) {
    setWorkflows((items) => items.map((workflow) => workflow.id === workflowId ? { ...workflow, status: nextStatus(workflow.status) } : workflow));
  }

  return (
    <div className="workflow-board">
      <div className="workflow-toolbar"><div><strong>{workflows.filter((item) => item.status === "live").length} live</strong><span>of 3 required workflows</span></div><Button size="small"><Plus size={14} /> New workflow</Button></div>
      <div className="workflow-grid">
        {workflows.map((workflow) => {
          const next = nextStatus(workflow.status);
          return (
            <article className={`workflow-card ${workflow.engine}`} key={workflow.id}>
              <div className="workflow-card-head"><span>{workflow.engine} engine</span><i className={`status-pill ${workflow.status}`}>{statusLabels[workflow.status]}</i></div>
              <h2>{workflow.name}</h2>
              <p>{workflow.problem}</p>
              <dl>
                <div><dt><UserRound size={13} /> Owner</dt><dd>{workflow.owner}</dd></div>
                <div><dt><ShieldCheck size={13} /> Human check</dt><dd>{workflow.humanReviewPoint}</dd></div>
              </dl>
              <div className="workflow-metric"><span>Baseline<strong>{workflow.baseline}</strong></span><ArrowRight size={15} /><span>Target<strong>{workflow.target}</strong></span></div>
              <div className="workflow-tools">{workflow.approvedTools.map((tool) => <span key={tool}>{tool}</span>)}</div>
              {workflow.status !== "paused" ? <Button aria-label={`Move ${workflow.name} to ${statusLabels[next]}`} onClick={() => advance(workflow.id)} size="small" variant="secondary">{workflow.status === "live" ? <CirclePause size={14} /> : <ArrowRight size={14} />} {workflow.status === "live" ? "Pause workflow" : `Move to ${statusLabels[next].toLowerCase()}`}</Button> : <Button aria-label={`Resume ${workflow.name}`} onClick={() => setWorkflows((items) => items.map((item) => item.id === workflow.id ? { ...item, status: "testing" } : item))} size="small" variant="secondary">Resume testing</Button>}
            </article>
          );
        })}
      </div>
    </div>
  );
}
