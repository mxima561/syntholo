"use client";

import { useMemo, useState } from "react";
import { Check, Clock3, FileText, MessageSquareText, Save, Send, Workflow } from "lucide-react";
import type { Artifact } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { calculateProgramCompletion } from "./completion";

const weeks = [
  { label: "Week 1", title: "Diagnose + set rules", detail: "Finish the readiness map and team AI policy." },
  { label: "Week 2", title: "Launch the growth engine", detail: "Build lead response, qualification, and follow-up." },
  { label: "Week 3", title: "Build client + management", detail: "Test onboarding and the weekly owner brief." },
  { label: "Week 4", title: "Enable + improve", detail: "Train the team and commit to the 90-day roadmap." },
];

export function ImplementationPlan({ initialArtifacts }: { initialArtifacts: Artifact[] }) {
  const [artifacts, setArtifacts] = useState(initialArtifacts);
  const [selectedId, setSelectedId] = useState(initialArtifacts[2]?.id ?? initialArtifacts[0]?.id);
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0];
  const completion = useMemo(() => calculateProgramCompletion({
    completedLessons: 7,
    finalArtifacts: artifacts.filter((artifact) => artifact.status === "final").length,
    liveWorkflows: artifacts.flatMap((artifact) => artifact.workflows ?? []).filter((workflow) => workflow.status === "live").length,
  }), [artifacts]);

  function requestReview() {
    setArtifacts((items) => items.map((artifact) => artifact.id === selected.id ? { ...artifact, reviewStatus: "requested" } : artifact));
  }

  function finalize() {
    setArtifacts((items) => items.map((artifact) => artifact.id === selected.id ? { ...artifact, status: "final", version: artifact.version + 1 } : artifact));
  }

  return (
    <div className="plan-workspace implementation-workspace">
      <section className="plan-timeline">
        <div className="program-meter"><div><strong>{completion.percent}%</strong><span>program outcome complete</span></div><div className="program-meter-track"><i style={{ width: `${completion.percent}%` }} /></div></div>
        <div className="week-grid">{weeks.map((week, index) => <article className={index === 1 ? "active" : index === 0 ? "done" : ""} key={week.label}><span>{index === 0 ? <Check size={12} /> : `0${index + 1}`}</span><div><small>{week.label}</small><strong>{week.title}</strong><p>{week.detail}</p></div></article>)}</div>
      </section>
      <div className="plan-content-grid implementation-content-grid">
        <aside className="artifact-nav"><span className="micro-label">Required outputs</span>{artifacts.map((artifact) => <button className={artifact.id === selected.id ? "active" : ""} key={artifact.id} onClick={() => setSelectedId(artifact.id)} type="button"><span className={`artifact-state ${artifact.status}`}>{artifact.status === "final" ? <Check size={12} /> : <FileText size={12} />}</span><div><strong>{artifact.title}</strong><small>{artifact.status.replace("_", " ")} · v{artifact.version}</small></div></button>)}</aside>
        <section className="artifact-editor">
          <div className="artifact-editor-head"><div><span className="micro-label">Shared business document</span><h2>{selected.title}</h2><p>Last changed by {selected.updatedBy} · Version {selected.version}</p></div><i className={`status-pill ${selected.status}`}>{selected.status.replace("_", " ")}</i></div>
          {selected.workflows ? <div className="portfolio-preview">{selected.workflows.map((workflow) => <article key={workflow.id}><span><Workflow size={16} /></span><div><strong>{workflow.name}</strong><small>{workflow.engine} engine · {workflow.owner}</small></div><i className={`status-pill ${workflow.status}`}>{workflow.status}</i></article>)}</div> : <div className="document-preview"><span className="micro-label">Draft structure</span><h3>Purpose and scope</h3><p>This working output gives the team one approved source of truth. Keep decisions specific, name owners, and review it every quarter.</p><h3>Owner decisions</h3><ul><li>What the team may do</li><li>Where human review is required</li><li>How the result will be measured</li></ul></div>}
          <div className="artifact-actions"><span><Clock3 size={13} /> Autosaved just now</span><div><Button onClick={finalize} size="small" variant="secondary"><Save size={14} /> Save final</Button><Button disabled={selected.reviewStatus === "requested"} onClick={requestReview} size="small"><Send size={14} /> {selected.reviewStatus === "requested" ? "Review requested" : "Ask coach to review"}</Button></div></div>
        </section>
        <aside className="review-rail"><span className="coach-avatar">NR</span><span className="micro-label">Human review</span><h2>Naomi can review this.</h2><p>Ask a focused question and attach this version. Feedback arrives in your support inbox.</p><label>What should we check?<textarea defaultValue="Is this specific enough for the team to use without me?" /></label><Button onClick={requestReview} size="small" variant="human"><MessageSquareText size={14} /> Request feedback</Button></aside>
      </div>
    </div>
  );
}
