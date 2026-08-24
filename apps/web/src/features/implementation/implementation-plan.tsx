"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, Clock3, FileText, MessageSquareText, Save, Send, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestArtifactReviewAction, saveArtifactAction } from "@/app/learn/actions";
import { calculateProgramCompletion } from "./completion";

export type PlanArtifact = {
  id: string;
  kind: string;
  title: string;
  status: "not_started" | "draft" | "final";
  version: number;
  body: string;
  reviewStatus: "none" | "requested" | "feedback_ready";
  updatedBy: string;
  updatedAt: string;
};

const weeks = [
  { label: "Week 1", title: "Diagnose + set rules", detail: "Finish the readiness map and team AI policy." },
  { label: "Week 2", title: "Launch the growth engine", detail: "Build lead response, qualification, and follow-up." },
  { label: "Week 3", title: "Build client + management", detail: "Test onboarding and the weekly owner brief." },
  { label: "Week 4", title: "Enable + improve", detail: "Train the team and commit to the 90-day roadmap." },
];

export function ImplementationPlan({
  initialArtifacts,
  completedLessons,
  liveWorkflows,
}: {
  initialArtifacts: PlanArtifact[];
  completedLessons: number;
  liveWorkflows: number;
}) {
  const [artifacts, setArtifacts] = useState(initialArtifacts);
  const [selectedId, setSelectedId] = useState(initialArtifacts[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0];
  const completion = useMemo(() => calculateProgramCompletion({
    completedLessons,
    finalArtifacts: artifacts.filter((artifact) => artifact.status === "final").length,
    liveWorkflows,
  }), [artifacts, completedLessons, liveWorkflows]);

  if (!selected) {
    return <p className="empty-note">Your implementation documents will appear here after you join the academy.</p>;
  }

  function persist(formData: FormData, finalize: boolean) {
    if (finalize) formData.set("finalize", "1");
    startTransition(async () => {
      await saveArtifactAction(formData);
      setArtifacts((items) => items.map((artifact) => artifact.id === selected.id
        ? { ...artifact, body: String(formData.get("body") ?? artifact.body), status: finalize ? "final" : "draft", version: artifact.version + 1 }
        : artifact));
    });
  }

  function requestReview(formData: FormData) {
    startTransition(async () => {
      await requestArtifactReviewAction(formData);
      setArtifacts((items) => items.map((artifact) => artifact.id === selected.id
        ? { ...artifact, reviewStatus: "requested", body: String(formData.get("body") ?? artifact.body) }
        : artifact));
    });
  }

  return (
    <div className="plan-workspace implementation-workspace">
      <section className="plan-timeline">
        <div className="program-meter"><div><strong>{completion.percent}%</strong><span>program outcome complete</span></div><div className="program-meter-track"><i style={{ width: `${completion.percent}%` }} /></div></div>
        <div className="week-grid">{weeks.map((week, index) => <article className={index === 0 && completedLessons >= 3 ? "done" : index === 1 && completedLessons >= 6 ? "active" : ""} key={week.label}><span>{index === 0 && completedLessons >= 3 ? <Check size={12} /> : `0${index + 1}`}</span><div><small>{week.label}</small><strong>{week.title}</strong><p>{week.detail}</p></div></article>)}</div>
      </section>
      <div className="plan-content-grid implementation-content-grid">
        <aside className="artifact-nav"><span className="micro-label">Required outputs</span>{artifacts.map((artifact) => <button className={artifact.id === selected.id ? "active" : ""} key={artifact.id} onClick={() => setSelectedId(artifact.id)} type="button"><span className={`artifact-state ${artifact.status}`}>{artifact.status === "final" ? <Check size={12} /> : <FileText size={12} />}</span><div><strong>{artifact.title}</strong><small>{artifact.status.replace("_", " ")} · v{artifact.version}</small></div></button>)}</aside>
        <section className="artifact-editor">
          <div className="artifact-editor-head"><div><span className="micro-label">Shared business document</span><h2>{selected.title}</h2><p>Last changed by {selected.updatedBy || "you"} · Version {selected.version}</p></div><i className={`status-pill ${selected.status}`}>{selected.status.replace("_", " ")}</i></div>
          {selected.kind === "workflow_portfolio" ? (
            <div className="portfolio-preview"><article><span><Workflow size={16} /></span><div><strong>Track the three required workflows</strong><small>Edit this document, then mark each workflow live in Workflows.</small></div></article></div>
          ) : null}
          <form action={(formData) => persist(formData, false)}>
            <input name="artifactId" type="hidden" value={selected.id} />
            <label className="artifact-body-label">Working draft
              <textarea aria-label={`${selected.title} draft`} defaultValue={selected.body} key={selected.id} name="body" rows={14} />
            </label>
            <div className="artifact-actions">
              <span><Clock3 size={13} /> Saved to your account</span>
              <div>
                <Button disabled={pending} size="small" type="submit" variant="secondary"><Save size={14} /> Save draft</Button>
                <Button disabled={pending} formAction={(formData) => persist(formData, true)} size="small" type="submit">Save final</Button>
              </div>
            </div>
          </form>
        </section>
        <aside className="review-rail">
          <span className="coach-avatar">NR</span>
          <span className="micro-label">Human review</span>
          <h2>Ask a coach to review this.</h2>
          <p>This opens a real support thread with this document attached. Feedback arrives in Human support.</p>
          <form action={requestReview}>
            <input name="artifactId" type="hidden" value={selected.id} />
            <input name="body" type="hidden" value={selected.body} />
            <label>What should we check?<textarea defaultValue="Is this specific enough for the team to use without me?" name="question" /></label>
            <Button disabled={pending || selected.reviewStatus === "requested"} size="small" type="submit" variant="human"><MessageSquareText size={14} /> {selected.reviewStatus === "requested" ? "Review requested" : "Ask coach to review"}</Button>
          </form>
        </aside>
      </div>
    </div>
  );
}
