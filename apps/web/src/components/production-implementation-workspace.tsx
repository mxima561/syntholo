"use client";

import { useAuth } from "@clerk/react";
import {
  ArtifactDetailResponseSchema,
  ArtifactListResponseSchema,
  ArtifactVersionsResponseSchema,
  SaveArtifactVersionRequestSchema,
  SaveArtifactVersionResponseSchema,
  type ArtifactContent,
  type ArtifactDetailResponse,
  type ArtifactListResponse,
  type ArtifactState,
  type ArtifactVersionsResponse,
  type WorkflowContent,
} from "@syntholo/contracts/implementation";
import { ApiErrorSchema } from "@syntholo/contracts/http";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createMemberApiClient } from "@/lib/api/client";

type View = "plan" | "workflows";
type SaveState = "saved" | "dirty" | "saving" | "ambiguous" | "conflict" | "invalid";
type ValidationIssue = Readonly<{ path: string; message: string }>;
type Draft = Readonly<{ content: ArtifactContent; revision: number; savedRevision: number }>;
type Ready = Readonly<{
  sessionId: string;
  state: "ready";
  artifacts: ArtifactListResponse;
  selectedId: string;
  details: Readonly<Record<string, ArtifactDetailResponse>>;
  drafts: Readonly<Record<string, Draft>>;
  saveStates: Readonly<Record<string, SaveState>>;
  histories: Readonly<Record<string, ArtifactVersionsResponse>>;
  conflicts: Readonly<Record<string, ArtifactDetailResponse | "loading" | null>>;
  validationIssues: Readonly<Record<string, readonly ValidationIssue[]>>;
}>;
type Workspace =
  | Ready
  | Readonly<{ sessionId: string; state: "loading" }>
  | Readonly<{ sessionId: string; state: "unavailable" }>
  | Readonly<{ sessionId: string; state: "unauthorized" }>;
type SaveIntent = Readonly<{
  sessionId: string;
  artifactId: string;
  key: string;
  body: string;
  revision: number;
}>;

function emptyContent(kind: ArtifactContent["kind"]): ArtifactContent {
  switch (kind) {
    case "readiness_map": return { kind, priorities: [], notes: "" };
    case "ai_policy": return { kind, purpose: "", approvedUses: [], prohibitedUses: [], humanReviewRules: [] };
    case "workflow_portfolio": return { kind, workflows: [] };
    case "enablement_checklist": return { kind, owner: "", items: [] };
    case "roadmap": return { kind, objective: "", milestones: [] };
  }
}

function implementationKey(): string {
  return `impl-${globalThis.crypto.randomUUID()}`;
}

function statusCopy(state: SaveState): string {
  switch (state) {
    case "saved": return "All changes saved";
    case "dirty": return "Unsynced changes";
    case "saving": return "Saving changes";
    case "ambiguous": return "Save result unknown. Retry uses the exact same request.";
    case "conflict": return "This document changed in another session. Your unsynced draft is preserved.";
    case "invalid": return "Unsynced changes contain incomplete, invalid, or oversized fields. Fix them to resume saving.";
  }
}

async function responseCode(response: Response): Promise<string | null> {
  if (!isJsonResponse(response)) return null;
  try {
    const parsed = ApiErrorSchema.safeParse(await response.clone().json());
    const correlationId = response.headers.get("x-correlation-id");
    return parsed.success && correlationId === parsed.data.error.correlationId
      ? parsed.data.error.code
      : null;
  } catch {
    return null;
  }
}

function isJsonResponse(response: Response): boolean {
  return /^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "");
}

function canonicalContent(content: ArtifactContent): ArtifactContent {
  return JSON.parse(JSON.stringify(content, (_key, value: unknown) =>
    typeof value === "string" ? value.trim() : value)) as ArtifactContent;
}

function incompleteFinalPaths(content: ArtifactContent): string[] {
  const missing = (entries: readonly (readonly [string, string | readonly unknown[]])[]) => entries
    .filter(([, value]) => typeof value === "string" ? value.length === 0 : value.length === 0)
    .map(([path]) => path);
  switch (content.kind) {
    case "readiness_map":
      return [
        ...missing([["content.notes", content.notes], ["content.priorities", content.priorities]]),
        ...content.priorities.flatMap((priority, index) => missing([
          [`content.priorities.${index}.opportunity`, priority.opportunity],
          [`content.priorities.${index}.currentState`, priority.currentState],
          [`content.priorities.${index}.targetOutcome`, priority.targetOutcome],
          [`content.priorities.${index}.owner`, priority.owner],
        ])),
      ];
    case "ai_policy":
      return [
        ...missing([["content.purpose", content.purpose], ["content.approvedUses", content.approvedUses], ["content.prohibitedUses", content.prohibitedUses], ["content.humanReviewRules", content.humanReviewRules]]),
        ...(["approvedUses", "prohibitedUses", "humanReviewRules"] as const).flatMap((field) =>
          content[field].flatMap((value, index) => value.length === 0 ? [`content.${field}.${index}`] : [])),
      ];
    case "workflow_portfolio":
      return [
        ...(content.workflows.length === 3 ? [] : ["content.workflows"]),
        ...content.workflows.flatMap((workflow, index) => missing([
          [`content.workflows.${index}.name`, workflow.name],
          [`content.workflows.${index}.problem`, workflow.problem],
          [`content.workflows.${index}.trigger`, workflow.trigger],
          [`content.workflows.${index}.owner`, workflow.owner],
          [`content.workflows.${index}.approvedTools`, workflow.approvedTools],
          ...workflow.approvedTools.map((value, itemIndex) => [`content.workflows.${index}.approvedTools.${itemIndex}`, value] as const),
          [`content.workflows.${index}.steps`, workflow.steps],
          ...workflow.steps.map((value, itemIndex) => [`content.workflows.${index}.steps.${itemIndex}`, value] as const),
          [`content.workflows.${index}.humanReviewPoint`, workflow.humanReviewPoint],
          [`content.workflows.${index}.safetyNotes`, workflow.safetyNotes],
          [`content.workflows.${index}.baseline`, workflow.baseline],
          [`content.workflows.${index}.target`, workflow.target],
        ])),
      ];
    case "enablement_checklist":
      return [
        ...missing([["content.owner", content.owner], ["content.items", content.items]]),
        ...content.items.flatMap((item, index) => item.label.length === 0 ? [`content.items.${index}.label`] : []),
      ];
    case "roadmap":
      return [
        ...missing([["content.objective", content.objective], ["content.milestones", content.milestones]]),
        ...content.milestones.flatMap((milestone, index) => missing([
          [`content.milestones.${index}.outcome`, milestone.outcome],
          [`content.milestones.${index}.owner`, milestone.owner],
        ])),
      ];
  }
}

function liveWorkflowPaths(content: ArtifactContent): string[] {
  if (content.kind !== "workflow_portfolio") return [];
  return content.workflows.flatMap((workflow, index) => workflow.lifecycleState !== "live" ? [] : [
    ...(workflow.testStatus === "passed" ? [] : [`content.workflows.${index}.testStatus`]),
    ...(workflow.launchDate === null ? [`content.workflows.${index}.launchDate`] : []),
    ...missingWorkflowPaths(workflow, index),
  ]);
}

function missingWorkflowPaths(workflow: WorkflowContent, index: number): string[] {
  const entries: readonly [string, string | readonly unknown[]][] = [
    [`content.workflows.${index}.name`, workflow.name], [`content.workflows.${index}.problem`, workflow.problem],
    [`content.workflows.${index}.trigger`, workflow.trigger], [`content.workflows.${index}.owner`, workflow.owner],
    [`content.workflows.${index}.approvedTools`, workflow.approvedTools], [`content.workflows.${index}.steps`, workflow.steps],
    [`content.workflows.${index}.humanReviewPoint`, workflow.humanReviewPoint], [`content.workflows.${index}.safetyNotes`, workflow.safetyNotes],
    [`content.workflows.${index}.baseline`, workflow.baseline], [`content.workflows.${index}.target`, workflow.target],
  ];
  return entries.filter(([, value]) => typeof value === "string" ? value.length === 0 : value.length === 0).map(([path]) => path);
}

function validationIssues(request: Readonly<{ expectedVersion: number; state: ArtifactState; content: ArtifactContent }>): readonly ValidationIssue[] {
  const parsed = SaveArtifactVersionRequestSchema.safeParse(request);
  if (parsed.success) return [];
  const issues = parsed.error.issues
    .filter((issue) => issue.path.length > 0)
    .map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  const finalPaths = request.state === "final" ? incompleteFinalPaths(request.content) : [];
  const livePaths = liveWorkflowPaths(request.content);
  return [...issues, ...finalPaths.map((path) => ({ path, message: "Required for a final version" })), ...livePaths.map((path) => ({ path, message: "Required for a live workflow" }))]
    .filter((issue, index, all) => all.findIndex((candidate) => candidate.path === issue.path && candidate.message === issue.message) === index);
}

function invalidField(issues: readonly ValidationIssue[], path: string) {
  const invalid = issues.some((issue) => issue.path === path || issue.path.startsWith(`${path}.`));
  return invalid ? { "aria-describedby": "implementation-validation-summary", "aria-invalid": true as const } : {};
}

function Lines({ issues, label, path, value, onChange }: Readonly<{
  issues: readonly ValidationIssue[];
  label: string;
  path: string;
  value: readonly string[];
  onChange(value: string[]): void;
}>) {
  return (
    <label>{label}<textarea {...invalidField(issues, path)} value={value.join("\n")} onChange={(event) => onChange(event.target.value.split("\n"))} /></label>
  );
}

function TextField({ issues, label, path, value, onChange, multiline = false, type = "text" }: Readonly<{
  issues: readonly ValidationIssue[];
  label: string;
  path: string;
  value: string;
  onChange(value: string): void;
  multiline?: boolean;
  type?: "text" | "date";
}>) {
  return (
    <label>{label}{multiline
      ? <textarea {...invalidField(issues, path)} value={value} onChange={(event) => onChange(event.target.value)} />
      : <input {...invalidField(issues, path)} type={type} value={value} onChange={(event) => onChange(event.target.value)} />}</label>
  );
}

function blankWorkflow(): WorkflowContent {
  return {
    name: "", engine: "growth", problem: "", trigger: "", owner: "",
    approvedTools: [], steps: [], humanReviewPoint: "", safetyNotes: "",
    baseline: "", target: "", lifecycleState: "draft", testStatus: "not_started",
    launchDate: null,
  };
}

function WorkflowEditor({ content, issues, onChange }: Readonly<{
  content: Extract<ArtifactContent, { kind: "workflow_portfolio" }>;
  issues: readonly ValidationIssue[];
  onChange(content: ArtifactContent): void;
}>) {
  const replace = (index: number, workflow: WorkflowContent) => onChange({
    ...content,
    workflows: content.workflows.map((item, itemIndex) => itemIndex === index ? workflow : item),
  });
  return (
    <div className="production-workflow-editor">
      <div className="production-workflow-toolbar">
        <p>{content.workflows.length} of 3 workflows defined</p>
        <button disabled={content.workflows.length >= 3} onClick={() => onChange({ ...content, workflows: [...content.workflows, blankWorkflow()] })} type="button">Add workflow</button>
      </div>
      {content.workflows.map((workflow, index) => (
        <fieldset key={index}>
          <legend>Workflow {index + 1}</legend>
          <TextField issues={issues} label="Name" path={`content.workflows.${index}.name`} value={workflow.name} onChange={(name) => replace(index, { ...workflow, name })} />
          <label>Engine<select value={workflow.engine} onChange={(event) => replace(index, { ...workflow, engine: event.target.value as WorkflowContent["engine"] })}><option value="growth">Growth</option><option value="client">Client</option><option value="management">Management</option></select></label>
          <TextField issues={issues} label="Problem" path={`content.workflows.${index}.problem`} multiline value={workflow.problem} onChange={(problem) => replace(index, { ...workflow, problem })} />
          <TextField issues={issues} label="Trigger" path={`content.workflows.${index}.trigger`} multiline value={workflow.trigger} onChange={(trigger) => replace(index, { ...workflow, trigger })} />
          <TextField issues={issues} label="Owner" path={`content.workflows.${index}.owner`} value={workflow.owner} onChange={(owner) => replace(index, { ...workflow, owner })} />
          <Lines issues={issues} label="Approved tools" path={`content.workflows.${index}.approvedTools`} value={workflow.approvedTools} onChange={(approvedTools) => replace(index, { ...workflow, approvedTools })} />
          <Lines issues={issues} label="Steps" path={`content.workflows.${index}.steps`} value={workflow.steps} onChange={(steps) => replace(index, { ...workflow, steps })} />
          <TextField issues={issues} label="Human review point" path={`content.workflows.${index}.humanReviewPoint`} multiline value={workflow.humanReviewPoint} onChange={(humanReviewPoint) => replace(index, { ...workflow, humanReviewPoint })} />
          <TextField issues={issues} label="Safety notes" path={`content.workflows.${index}.safetyNotes`} multiline value={workflow.safetyNotes} onChange={(safetyNotes) => replace(index, { ...workflow, safetyNotes })} />
          <TextField issues={issues} label="Baseline" path={`content.workflows.${index}.baseline`} value={workflow.baseline} onChange={(baseline) => replace(index, { ...workflow, baseline })} />
          <TextField issues={issues} label="Target" path={`content.workflows.${index}.target`} value={workflow.target} onChange={(target) => replace(index, { ...workflow, target })} />
          <label>Lifecycle state<select value={workflow.lifecycleState} onChange={(event) => replace(index, { ...workflow, lifecycleState: event.target.value as WorkflowContent["lifecycleState"] })}><option value="draft">Draft</option><option value="testing">Testing</option><option value="live">Live</option><option value="paused">Paused</option></select></label>
          <label>Test status<select {...invalidField(issues, `content.workflows.${index}.testStatus`)} value={workflow.testStatus} onChange={(event) => replace(index, { ...workflow, testStatus: event.target.value as WorkflowContent["testStatus"] })}><option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="passed">Passed</option><option value="failed">Failed</option></select></label>
          <TextField issues={issues} label="Launch date" path={`content.workflows.${index}.launchDate`} type="date" value={workflow.launchDate ?? ""} onChange={(launchDate) => replace(index, { ...workflow, launchDate: launchDate || null })} />
          <button aria-label={`Remove workflow ${index + 1}`} onClick={() => onChange({ ...content, workflows: content.workflows.filter((_, itemIndex) => itemIndex !== index) })} type="button">Remove workflow</button>
        </fieldset>
      ))}
    </div>
  );
}

function ContentEditor({ content, issues, onChange }: Readonly<{
  content: ArtifactContent;
  issues: readonly ValidationIssue[];
  onChange(content: ArtifactContent): void;
}>) {
  switch (content.kind) {
    case "readiness_map":
      return <div className="production-structured-fields"><TextField issues={issues} label="Notes" path="content.notes" multiline value={content.notes} onChange={(notes) => onChange({ ...content, notes })} /><button disabled={content.priorities.length >= 25} onClick={() => onChange({ ...content, priorities: [...content.priorities, { opportunity: "", currentState: "", targetOutcome: "", owner: "" }] })} type="button">Add priority</button>{content.priorities.map((priority, index) => <fieldset key={index}><legend>Priority {index + 1}</legend>{(["opportunity", "currentState", "targetOutcome", "owner"] as const).map((field) => <TextField issues={issues} path={`content.priorities.${index}.${field}`} key={field} label={({ opportunity: "Opportunity", currentState: "Current state", targetOutcome: "Target outcome", owner: "Owner" })[field]} value={priority[field]} onChange={(value) => onChange({ ...content, priorities: content.priorities.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item) })} />)}<button aria-label={`Remove priority ${index + 1}`} onClick={() => onChange({ ...content, priorities: content.priorities.filter((_, itemIndex) => itemIndex !== index) })} type="button">Remove priority</button></fieldset>)}</div>;
    case "ai_policy":
      return <div className="production-structured-fields"><TextField issues={issues} label="Purpose" path="content.purpose" multiline value={content.purpose} onChange={(purpose) => onChange({ ...content, purpose })} /><Lines issues={issues} label="Approved uses" path="content.approvedUses" value={content.approvedUses} onChange={(approvedUses) => onChange({ ...content, approvedUses })} /><Lines issues={issues} label="Prohibited uses" path="content.prohibitedUses" value={content.prohibitedUses} onChange={(prohibitedUses) => onChange({ ...content, prohibitedUses })} /><Lines issues={issues} label="Human review rules" path="content.humanReviewRules" value={content.humanReviewRules} onChange={(humanReviewRules) => onChange({ ...content, humanReviewRules })} /></div>;
    case "workflow_portfolio": return <WorkflowEditor content={content} issues={issues} onChange={onChange} />;
    case "enablement_checklist":
      return <div className="production-structured-fields"><TextField issues={issues} label="Owner" path="content.owner" value={content.owner} onChange={(owner) => onChange({ ...content, owner })} /><button disabled={content.items.length >= 50} onClick={() => onChange({ ...content, items: [...content.items, { label: "", complete: false }] })} type="button">Add checklist item</button>{content.items.map((item, index) => <fieldset key={index}><legend>Checklist item {index + 1}</legend><TextField issues={issues} label={`Item ${index + 1}`} path={`content.items.${index}.label`} value={item.label} onChange={(label) => onChange({ ...content, items: content.items.map((entry, itemIndex) => itemIndex === index ? { ...entry, label } : entry) })} /><label><input checked={item.complete} type="checkbox" onChange={(event) => onChange({ ...content, items: content.items.map((entry, itemIndex) => itemIndex === index ? { ...entry, complete: event.target.checked } : entry) })} /> Complete</label><button aria-label={`Remove checklist item ${index + 1}`} onClick={() => onChange({ ...content, items: content.items.filter((_, itemIndex) => itemIndex !== index) })} type="button">Remove item</button></fieldset>)}</div>;
    case "roadmap":
      return <div className="production-structured-fields"><TextField issues={issues} label="Objective" path="content.objective" multiline value={content.objective} onChange={(objective) => onChange({ ...content, objective })} /><button disabled={content.milestones.length >= 25} onClick={() => onChange({ ...content, milestones: [...content.milestones, { horizon: "30_days", outcome: "", owner: "" }] })} type="button">Add milestone</button>{content.milestones.map((milestone, index) => <fieldset key={index}><legend>Milestone {index + 1}</legend><label>Horizon<select value={milestone.horizon} onChange={(event) => onChange({ ...content, milestones: content.milestones.map((item, itemIndex) => itemIndex === index ? { ...item, horizon: event.target.value as typeof milestone.horizon } : item) })}><option value="30_days">30 days</option><option value="60_days">60 days</option><option value="90_days">90 days</option></select></label><TextField issues={issues} label="Outcome" path={`content.milestones.${index}.outcome`} value={milestone.outcome} onChange={(outcome) => onChange({ ...content, milestones: content.milestones.map((item, itemIndex) => itemIndex === index ? { ...item, outcome } : item) })} /><TextField issues={issues} label="Owner" path={`content.milestones.${index}.owner`} value={milestone.owner} onChange={(owner) => onChange({ ...content, milestones: content.milestones.map((item, itemIndex) => itemIndex === index ? { ...item, owner } : item) })} /><button aria-label={`Remove milestone ${index + 1}`} onClick={() => onChange({ ...content, milestones: content.milestones.filter((_, itemIndex) => itemIndex !== index) })} type="button">Remove milestone</button></fieldset>)}</div>;
  }
}

function ImplementationWorkspaceSession({ auth, view }: Readonly<{
  auth: Readonly<{
    getToken(): Promise<string | null>;
    isLoaded: boolean;
    isSignedIn: boolean | undefined;
    sessionId: string | null | undefined;
  }>;
  view: View;
}>) {
  const { getToken, isLoaded, isSignedIn, sessionId } = auth;
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const workspaceRef = useRef(workspace);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  const generation = useRef(0);
  const pending = useRef(new Map<string, SaveIntent>());

  const hideAccountContent = useCallback((session: string) => {
    generation.current += 1;
    pending.current.clear();
    setWorkspace({ sessionId: session, state: "unauthorized" });
  }, []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !sessionId) return;
    const controller = new AbortController();
    const pendingIntents = pending.current;
    const activeGeneration = ++generation.current;
    const activeSession = sessionId;
    pendingIntents.clear();
    const api = createMemberApiClient({ getToken });
    void (async () => {
      try {
        const listResponse = await api("/v1/member/artifacts", { signal: controller.signal });
        if (controller.signal.aborted || generation.current !== activeGeneration) return;
        const listCode = listResponse.status === 404 ? await responseCode(listResponse) : null;
        if (controller.signal.aborted || generation.current !== activeGeneration) return;
        if (listResponse.status === 401 || listResponse.status === 403 || listCode === "NOT_FOUND") return hideAccountContent(activeSession);
        if (!listResponse.ok || !isJsonResponse(listResponse)) throw new Error("IMPLEMENTATION_LIST_FAILED");
        const artifacts = ArtifactListResponseSchema.parse(await listResponse.json());
        if (controller.signal.aborted || generation.current !== activeGeneration) return;
        const selected = view === "workflows"
          ? artifacts.items.find(({ kind }) => kind === "workflow_portfolio")!
          : artifacts.items[0]!;
        const detailResponse = await api(`/v1/member/artifacts/${selected.id}`, { signal: controller.signal });
        if (controller.signal.aborted || generation.current !== activeGeneration) return;
        const detailCode = detailResponse.status === 404 ? await responseCode(detailResponse) : null;
        if (controller.signal.aborted || generation.current !== activeGeneration) return;
        if (detailResponse.status === 401 || detailResponse.status === 403 || detailCode === "NOT_FOUND") return hideAccountContent(activeSession);
        if (!detailResponse.ok || !isJsonResponse(detailResponse)) throw new Error("IMPLEMENTATION_DETAIL_FAILED");
        const detail = ArtifactDetailResponseSchema.parse(await detailResponse.json());
        if (controller.signal.aborted || generation.current !== activeGeneration) return;
        const content = detail.content ?? emptyContent(detail.artifact.kind);
        setWorkspace({
          sessionId: activeSession,
          state: "ready",
          artifacts,
          selectedId: selected.id,
          details: { [selected.id]: detail },
          drafts: { [selected.id]: { content, revision: 0, savedRevision: 0 } },
          saveStates: { [selected.id]: "saved" },
          histories: {},
          conflicts: {},
          validationIssues: {},
        });
      } catch {
        if (!controller.signal.aborted && generation.current === activeGeneration) {
          setWorkspace({ sessionId: activeSession, state: "unavailable" });
        }
      }
    })();
    return () => {
      controller.abort();
      generation.current += 1;
      pendingIntents.clear();
    };
  }, [getToken, hideAccountContent, isLoaded, isSignedIn, sessionId, view]);

  const runIntent = useCallback(async (intent: SaveIntent) => {
    const activeGeneration = generation.current;
    setWorkspace((current) => current?.state === "ready" && current.sessionId === intent.sessionId
      ? { ...current, saveStates: { ...current.saveStates, [intent.artifactId]: "saving" } }
      : current);
    try {
      const api = createMemberApiClient({ getToken });
      const response = await api(`/v1/member/artifacts/${intent.artifactId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": intent.key },
        body: intent.body,
      });
      if (generation.current !== activeGeneration || sessionId !== intent.sessionId) return;
      if (response.status === 401 || response.status === 403) return hideAccountContent(intent.sessionId);
      if (response.status === 409) {
        const code = await responseCode(response);
        if (generation.current !== activeGeneration || sessionId !== intent.sessionId) return;
        if (code !== "IDEMPOTENCY_IN_PROGRESS") pending.current.delete(intent.artifactId);
        setWorkspace((current) => current?.state === "ready" && current.sessionId === intent.sessionId
          ? { ...current, saveStates: { ...current.saveStates, [intent.artifactId]: code === "VERSION_CONFLICT" ? "conflict" : code === "IDEMPOTENCY_IN_PROGRESS" ? "ambiguous" : "invalid" }, conflicts: code === "VERSION_CONFLICT" ? { ...current.conflicts, [intent.artifactId]: "loading" } : current.conflicts }
          : current);
        if (code === "VERSION_CONFLICT") {
          try {
            const latestResponse = await api(`/v1/member/artifacts/${intent.artifactId}`);
            if (generation.current !== activeGeneration || sessionId !== intent.sessionId) return;
            const latestCode = latestResponse.status === 404 ? await responseCode(latestResponse) : null;
            if (generation.current !== activeGeneration || sessionId !== intent.sessionId) return;
            if (latestResponse.status === 401 || latestResponse.status === 403 || latestCode === "NOT_FOUND") return hideAccountContent(intent.sessionId);
            if (!latestResponse.ok || !isJsonResponse(latestResponse)) throw new Error("CONFLICT_COMPARISON_UNAVAILABLE");
            const latest = ArtifactDetailResponseSchema.parse(await latestResponse.json());
            if (generation.current !== activeGeneration || sessionId !== intent.sessionId) return;
            setWorkspace((current) => current?.state === "ready" && current.sessionId === intent.sessionId
              ? { ...current, conflicts: { ...current.conflicts, [intent.artifactId]: latest } }
              : current);
          } catch {
            if (generation.current === activeGeneration && sessionId === intent.sessionId) {
              setWorkspace((current) => current?.state === "ready" && current.sessionId === intent.sessionId
                ? { ...current, conflicts: { ...current.conflicts, [intent.artifactId]: null } }
                : current);
            }
          }
        }
        return;
      }
      if (response.status >= 400 && response.status < 500) {
        const code = await responseCode(response);
        if (generation.current !== activeGeneration || sessionId !== intent.sessionId) return;
        if (response.status === 404 && code === "NOT_FOUND") return hideAccountContent(intent.sessionId);
        pending.current.delete(intent.artifactId);
        setWorkspace((current) => current?.state === "ready" && current.sessionId === intent.sessionId
          ? { ...current, saveStates: { ...current.saveStates, [intent.artifactId]: "invalid" } }
          : current);
        return;
      }
      if (!response.ok || !isJsonResponse(response)) throw new Error("IMPLEMENTATION_SAVE_FAILED");
      const saved = SaveArtifactVersionResponseSchema.parse(await response.json());
      if (generation.current !== activeGeneration || sessionId !== intent.sessionId) return;
      pending.current.delete(intent.artifactId);
      setWorkspace((current) => {
        if (current?.state !== "ready" || current.sessionId !== intent.sessionId) return current;
        const draft = current.drafts[intent.artifactId];
        if (draft === undefined) return current;
        const unchanged = draft.revision === intent.revision;
        return {
          ...current,
          artifacts: {
            ...current.artifacts,
            items: current.artifacts.items.map((item) => item.id === intent.artifactId ? saved.artifact : item),
            implementationCompletion: saved.implementationCompletion,
          },
          details: { ...current.details, [intent.artifactId]: { schemaVersion: 1, artifact: saved.artifact, content: saved.content } },
          drafts: { ...current.drafts, [intent.artifactId]: unchanged ? { content: saved.content, revision: draft.revision, savedRevision: draft.revision } : { ...draft, savedRevision: intent.revision } },
          saveStates: { ...current.saveStates, [intent.artifactId]: unchanged ? "saved" : "dirty" },
          validationIssues: { ...current.validationIssues, [intent.artifactId]: [] },
        };
      });
    } catch {
      if (generation.current === activeGeneration && sessionId === intent.sessionId) {
        setWorkspace((current) => current?.state === "ready" ? { ...current, saveStates: { ...current.saveStates, [intent.artifactId]: "ambiguous" } } : current);
      }
    }
  }, [getToken, hideAccountContent, sessionId]);

  const beginSave = useCallback((state: ArtifactState) => {
    const current = workspaceRef.current;
    if (current?.state !== "ready") return;
    const artifactId = current.selectedId;
    if (pending.current.has(artifactId)) return;
    const draft = current.drafts[artifactId];
    const detail = current.details[artifactId];
    if (draft === undefined || detail === undefined) return;
    const request = { expectedVersion: detail.artifact.currentVersion, state, content: canonicalContent(draft.content) };
    const issues = validationIssues(request);
    if (issues.length > 0) {
      setWorkspace({ ...current, saveStates: { ...current.saveStates, [artifactId]: "invalid" }, validationIssues: { ...current.validationIssues, [artifactId]: issues } });
      return;
    }
    const intent = { sessionId: current.sessionId, artifactId, key: implementationKey(), body: JSON.stringify(request), revision: draft.revision };
    pending.current.set(artifactId, intent);
    void runIntent(intent);
  }, [runIntent]);

  useEffect(() => {
    const current = workspace?.state === "ready" ? workspace : null;
    if (current === null) return;
    const draft = current.drafts[current.selectedId];
    const saveState = current.saveStates[current.selectedId];
    if (draft === undefined || draft.revision === draft.savedRevision || saveState === "saving" || saveState === "ambiguous" || saveState === "conflict" || saveState === "invalid") return;
    const timer = setTimeout(() => beginSave("draft"), 600);
    return () => clearTimeout(timer);
  }, [beginSave, workspace]);

  const selectArtifact = async (artifactId: string) => {
    const current = workspaceRef.current;
    if (current?.state !== "ready" || current.selectedId === artifactId) return;
    if (current.details[artifactId] !== undefined) {
      setWorkspace({ ...current, selectedId: artifactId });
      return;
    }
    const activeGeneration = generation.current;
    const activeSession = current.sessionId;
    setWorkspace({ ...current, selectedId: artifactId });
    try {
      const response = await createMemberApiClient({ getToken })(`/v1/member/artifacts/${artifactId}`);
      if (generation.current !== activeGeneration || sessionId !== activeSession) return;
      const code = response.status === 404 ? await responseCode(response) : null;
      if (generation.current !== activeGeneration || sessionId !== activeSession) return;
      if (response.status === 401 || response.status === 403 || code === "NOT_FOUND") return hideAccountContent(activeSession);
      if (!response.ok || !isJsonResponse(response)) throw new Error("IMPLEMENTATION_DETAIL_FAILED");
      const detail = ArtifactDetailResponseSchema.parse(await response.json());
      if (generation.current !== activeGeneration || sessionId !== activeSession) return;
      setWorkspace((latest) => latest?.state === "ready" && latest.sessionId === activeSession ? {
        ...latest,
        details: { ...latest.details, [artifactId]: detail },
        drafts: { ...latest.drafts, [artifactId]: { content: detail.content ?? emptyContent(detail.artifact.kind), revision: 0, savedRevision: 0 } },
        saveStates: { ...latest.saveStates, [artifactId]: "saved" },
      } : latest);
    } catch {
      if (generation.current === activeGeneration && sessionId === activeSession) {
        setWorkspace((latest) => latest?.state === "ready" && latest.sessionId === activeSession && latest.selectedId === artifactId
          ? { ...latest, selectedId: current.selectedId }
          : latest);
        setCopyNotice("That document could not be loaded. Your current draft is still here.");
      }
    }
  };

  const updateContent = (content: ArtifactContent) => {
    setCopyNotice(null);
    setWorkspace((current) => {
    if (current?.state !== "ready") return current;
    const prior = current.drafts[current.selectedId];
    if (prior === undefined) return current;
    const saveState = current.saveStates[current.selectedId];
    return { ...current, drafts: { ...current.drafts, [current.selectedId]: { ...prior, content, revision: prior.revision + 1 } }, saveStates: { ...current.saveStates, [current.selectedId]: saveState === "conflict" || saveState === "ambiguous" ? saveState : "dirty" }, validationIssues: { ...current.validationIssues, [current.selectedId]: [] } };
    });
  };

  const loadHistory = async (cursor?: string) => {
    const current = workspaceRef.current;
    if (current?.state !== "ready") return;
    const activeGeneration = generation.current;
    const activeSession = current.sessionId;
    const path = `/v1/member/artifacts/${current.selectedId}/versions?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    try {
      const response = await createMemberApiClient({ getToken })(path);
      if (generation.current !== activeGeneration || sessionId !== activeSession) return;
      const code = response.status === 404 ? await responseCode(response) : null;
      if (generation.current !== activeGeneration || sessionId !== activeSession) return;
      if (response.status === 401 || response.status === 403 || code === "NOT_FOUND") return hideAccountContent(activeSession);
      if (!response.ok || !isJsonResponse(response)) throw new Error("IMPLEMENTATION_HISTORY_FAILED");
      const history = ArtifactVersionsResponseSchema.parse(await response.json());
      if (generation.current !== activeGeneration || sessionId !== activeSession) return;
      setWorkspace((latest) => latest?.state === "ready" && latest.sessionId === activeSession ? {
        ...latest,
        histories: {
          ...latest.histories,
          [current.selectedId]: cursor && latest.histories[current.selectedId]
            ? { ...history, items: [...latest.histories[current.selectedId]!.items, ...history.items] }
            : history,
        },
      } : latest);
    } catch {
      if (generation.current === activeGeneration && sessionId === activeSession) setCopyNotice("Version history unavailable. Your unsynced draft is preserved.");
    }
  };

  const reloadServer = async () => {
    const current = workspaceRef.current;
    if (current?.state !== "ready") return;
    const activeGeneration = generation.current;
    const activeSession = current.sessionId;
    try {
      const response = await createMemberApiClient({ getToken })(`/v1/member/artifacts/${current.selectedId}`);
      if (generation.current !== activeGeneration || sessionId !== activeSession) return;
      const code = response.status === 404 ? await responseCode(response) : null;
      if (generation.current !== activeGeneration || sessionId !== activeSession) return;
      if (response.status === 401 || response.status === 403 || code === "NOT_FOUND") return hideAccountContent(activeSession);
      if (!response.ok || !isJsonResponse(response)) throw new Error("IMPLEMENTATION_RELOAD_FAILED");
      const detail = ArtifactDetailResponseSchema.parse(await response.json());
      if (generation.current !== activeGeneration || sessionId !== activeSession) return;
      pending.current.delete(current.selectedId);
      setCopyNotice(null);
      setWorkspace((latest) => latest?.state === "ready" && latest.sessionId === activeSession ? { ...latest, details: { ...latest.details, [current.selectedId]: detail }, drafts: { ...latest.drafts, [current.selectedId]: { content: detail.content ?? emptyContent(detail.artifact.kind), revision: 0, savedRevision: 0 } }, saveStates: { ...latest.saveStates, [current.selectedId]: "saved" }, validationIssues: { ...latest.validationIssues, [current.selectedId]: [] } } : latest);
    } catch {
      if (generation.current === activeGeneration && sessionId === activeSession) setCopyNotice("Server reload unavailable. Your unsynced draft is preserved.");
    }
  };

  if (!isLoaded || (isSignedIn && (workspace === null || workspace.sessionId !== sessionId || workspace.state === "loading"))) return <main className="state-page" role="status"><h1>Loading your implementation workspace</h1><p>Reading the shared outputs for this account.</p></main>;
  if (!isSignedIn) return <main className="state-page"><h1>Sign in to continue</h1><Link className="button button-primary button-medium" href={{ pathname: "/sign-in" }}>Member sign in</Link></main>;
  if (workspace === null || workspace.sessionId !== sessionId || workspace.state === "unauthorized") return <main className="state-page"><h1>Member account unavailable</h1><p>This sign-in cannot currently open the shared implementation workspace.</p></main>;
  if (workspace.state === "unavailable") return <main className="state-page" role="status"><h1>Implementation workspace unavailable</h1><p>No demo or stale account content was shown.</p></main>;
  if (workspace.state === "loading") return <main className="state-page" role="status"><h1>Loading your implementation workspace</h1><p>Reading the shared outputs for this account.</p></main>;

  const selected = workspace.artifacts.items.find(({ id }) => id === workspace.selectedId)!;
  const draft = workspace.drafts[selected.id];
  const saveState = workspace.saveStates[selected.id] ?? "saved";
  const history = workspace.histories[selected.id];
  const conflictSnapshot = workspace.conflicts[selected.id];
  const issues = workspace.validationIssues[selected.id] ?? [];
  const copyDraft = async () => {
    if (draft === undefined) return;
    try {
      if (navigator.clipboard === undefined) throw new Error("CLIPBOARD_UNAVAILABLE");
      await navigator.clipboard.writeText(JSON.stringify(draft.content, null, 2));
      setCopyNotice("Unsynced draft copied");
    } catch {
      setCopyNotice("Draft could not be copied. Your unsynced draft is still here.");
    }
  };
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = workspace.artifacts.items.length;
    const targetIndex = event.key === "ArrowRight" ? (index + 1) % count
      : event.key === "ArrowLeft" ? (index - 1 + count) % count
        : event.key === "Home" ? 0
          : event.key === "End" ? count - 1
            : null;
    if (targetIndex === null) return;
    event.preventDefault();
    const target = workspace.artifacts.items[targetIndex]!;
    void selectArtifact(target.id);
    document.getElementById(`implementation-tab-${target.id}`)?.focus();
  };
  return (
    <main className="member-page production-implementation-page">
      <section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Account-shared implementation</span><h1>{view === "workflows" ? "Your business workflows" : "Your implementation plan"}</h1><p>Structured outputs are shared with active members of this account and saved as immutable versions.</p></div></section>
      <div className="production-implementation-workspace">
        <p className="production-completion-state">
          {workspace.artifacts.implementationCompletion.completed
            ? `Implementation completed ${workspace.artifacts.implementationCompletion.completedAt}`
            : "Implementation completion is still in progress"}
        </p>
        <div aria-label="Implementation artifacts" className="production-artifact-tabs" role="tablist">
          {workspace.artifacts.items.map((artifact, index) => <button aria-controls={`implementation-panel-${artifact.id}`} aria-selected={artifact.id === selected.id} id={`implementation-tab-${artifact.id}`} key={artifact.id} onClick={() => void selectArtifact(artifact.id)} onKeyDown={(event) => onTabKeyDown(event, index)} role="tab" tabIndex={artifact.id === selected.id ? 0 : -1} type="button"><strong>{artifact.title}</strong><span>{artifact.currentState ?? "Not started"} · v{artifact.currentVersion}</span></button>)}
        </div>
        {workspace.artifacts.items.filter((artifact) => artifact.id !== selected.id).map((artifact) => (
          <section aria-labelledby={`implementation-tab-${artifact.id}`} hidden id={`implementation-panel-${artifact.id}`} key={artifact.id} role="tabpanel" />
        ))}
        <section aria-labelledby={`implementation-tab-${selected.id}`} className="production-artifact-editor" id={`implementation-panel-${selected.id}`} role="tabpanel" tabIndex={0}>
          <header><div><span className="micro-label">Shared output</span><h2>{selected.title}</h2><p>{selected.authorLabel === null ? "No saved version" : `${selected.authorLabel} · version ${selected.currentVersion}`}</p></div><span className={`status-pill ${selected.currentState ?? "draft"}`}>{selected.currentState ?? "Not started"}</span></header>
          {draft === undefined ? <p role="status">Loading this document…</p> : <ContentEditor content={draft.content} issues={issues} onChange={updateContent} />}
          {issues.length > 0 ? <div id="implementation-validation-summary" role="alert"><p>These unsynced fields need attention:</p><ul>{issues.map((issue) => <li key={`${issue.path}:${issue.message}`}><code>{issue.path}</code>: {issue.message}</li>)}</ul></div> : null}
          {saveState === "conflict" && draft ? (
            <section aria-label="Conflict comparison" className="production-conflict-comparison">
              <div><h3>Your unsynced draft</h3><pre>{JSON.stringify(draft.content, null, 2)}</pre></div>
              <div><h3>Latest server version</h3><pre>{conflictSnapshot === "loading" ? "Loading latest server version…" : conflictSnapshot == null ? "Latest comparison unavailable" : conflictSnapshot.content === null ? "No saved content" : JSON.stringify(conflictSnapshot.content, null, 2)}</pre></div>
            </section>
          ) : null}
          <footer className="production-artifact-actions">
            <p aria-live={saveState === "conflict" ? "assertive" : "polite"} role={saveState === "conflict" ? "alert" : "status"}>{copyNotice ?? statusCopy(saveState)}</p>
            <div>
              {saveState === "ambiguous" ? <button onClick={() => { const intent = pending.current.get(selected.id); if (intent) void runIntent(intent); }} type="button">Retry exact save</button> : null}
              {saveState === "conflict" ? <><button onClick={() => void copyDraft()} type="button">Copy unsynced draft</button><button onClick={() => void loadHistory()} type="button">View version history</button><button onClick={() => void reloadServer()} type="button">Reload server version</button></> : null}
              <button disabled={draft === undefined || saveState === "saving" || saveState === "conflict" || saveState === "ambiguous"} onClick={() => beginSave("final")} type="button">Save final version</button>
            </div>
          </footer>
          {history ? <div className="production-version-history"><ol aria-label="Version history">{history.items.map((version) => <li key={version.id}>Version {version.version} · {version.state} · {version.authorLabel} · {version.createdAt}</li>)}</ol>{history.nextCursor ? <button onClick={() => void loadHistory(history.nextCursor ?? undefined)} type="button">Load older versions</button> : null}</div> : null}
        </section>
      </div>
    </main>
  );
}

export function ProductionImplementationWorkspace({ view }: Readonly<{ view: View }>) {
  const auth = useAuth();
  const sessionKey = auth.isLoaded && auth.isSignedIn && auth.sessionId
    ? auth.sessionId
    : auth.isLoaded ? "signed-out" : "loading";
  return (
    <ImplementationWorkspaceSession
      auth={{
        getToken: auth.getToken,
        isLoaded: auth.isLoaded,
        isSignedIn: auth.isSignedIn,
        sessionId: auth.sessionId,
      }}
      key={sessionKey}
      view={view}
    />
  );
}
