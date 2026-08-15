import { createHash } from "node:crypto";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

export function canonicalizeArtifactContent(content: JsonValue): Readonly<{
  canonicalJson: string;
  hash: string;
}> {
  const canonical = canonicalJson(content);
  return Object.freeze({
    canonicalJson: canonical,
    hash: createHash("sha256").update(canonical, "utf8").digest("hex"),
  });
}

export function nextArtifactVersion(currentVersion: number, expectedVersion: number): number {
  if (
    !Number.isInteger(currentVersion)
    || currentVersion < 0
    || currentVersion > 2_147_483_646
    || !Number.isInteger(expectedVersion)
    || expectedVersion !== currentVersion
  ) throw new Error("VERSION_CONFLICT");
  return currentVersion + 1;
}

type Workflow = Readonly<{
  name: string;
  problem: string;
  trigger: string;
  owner: string;
  approvedTools: readonly string[];
  steps: readonly string[];
  humanReviewPoint: string;
  safetyNotes: string;
  baseline: string;
  target: string;
  lifecycleState: "draft" | "testing" | "live" | "paused";
  testStatus: "not_started" | "in_progress" | "passed" | "failed";
  launchDate: string | null;
}>;

function nonblank(value: string): boolean {
  return value.trim().length > 0;
}

function completeWorkflow(workflow: Workflow): boolean {
  return [
    workflow.name,
    workflow.problem,
    workflow.trigger,
    workflow.owner,
    workflow.humanReviewPoint,
    workflow.safetyNotes,
    workflow.baseline,
    workflow.target,
  ].every(nonblank)
    && workflow.approvedTools.length > 0
    && workflow.approvedTools.every(nonblank)
    && workflow.steps.length > 0
    && workflow.steps.every(nonblank);
}

export function assertArtifactFinalizable(content: Readonly<{
  kind: string;
  [key: string]: unknown;
  workflows?: readonly Workflow[];
}>): void {
  const nonemptyStrings = (values: unknown): boolean =>
    Array.isArray(values) && values.length > 0
      && values.every((value) => typeof value === "string" && nonblank(value));
  switch (content.kind) {
    case "readiness_map": {
      const priorities = content.priorities;
      if (
        typeof content.notes !== "string" || !nonblank(content.notes)
        || !Array.isArray(priorities) || priorities.length === 0
        || priorities.some((priority) => typeof priority !== "object" || priority === null
          || !["opportunity", "currentState", "targetOutcome", "owner"].every((key) =>
            typeof (priority as Record<string, unknown>)[key] === "string"
            && nonblank((priority as Record<string, string>)[key]!)))
      ) throw new Error("IMPLEMENTATION_ARTIFACT_INCOMPLETE");
      return;
    }
    case "ai_policy":
      if (
        typeof content.purpose !== "string" || !nonblank(content.purpose)
        || !nonemptyStrings(content.approvedUses)
        || !nonemptyStrings(content.prohibitedUses)
        || !nonemptyStrings(content.humanReviewRules)
      ) throw new Error("IMPLEMENTATION_ARTIFACT_INCOMPLETE");
      return;
    case "workflow_portfolio": {
      const workflows = content.workflows ?? [];
      if (workflows.length !== 3 || workflows.some((workflow) => !completeWorkflow(workflow))) {
        throw new Error("IMPLEMENTATION_PORTFOLIO_INCOMPLETE");
      }
      return;
    }
    case "enablement_checklist": {
      const items = content.items;
      if (
        typeof content.owner !== "string" || !nonblank(content.owner)
        || !Array.isArray(items) || items.length === 0
        || items.some((item) => typeof item !== "object" || item === null
          || typeof (item as Record<string, unknown>).label !== "string"
          || !nonblank((item as Record<string, string>).label!))
      ) throw new Error("IMPLEMENTATION_ARTIFACT_INCOMPLETE");
      return;
    }
    case "roadmap": {
      const milestones = content.milestones;
      if (
        typeof content.objective !== "string" || !nonblank(content.objective)
        || !Array.isArray(milestones) || milestones.length === 0
        || milestones.some((milestone) => typeof milestone !== "object" || milestone === null
          || !["outcome", "owner"].every((key) =>
            typeof (milestone as Record<string, unknown>)[key] === "string"
            && nonblank((milestone as Record<string, string>)[key]!)))
      ) throw new Error("IMPLEMENTATION_ARTIFACT_INCOMPLETE");
      return;
    }
    default:
      throw new Error("IMPLEMENTATION_ARTIFACT_INCOMPLETE");
  }
}

type PersonalCompletion = Readonly<{ id: string; completedAt: string }>;

export function selectEarliestPersonalCompletion(
  completions: readonly PersonalCompletion[],
): PersonalCompletion | null {
  return [...completions].sort((left, right) =>
    left.completedAt.localeCompare(right.completedAt)
    || left.id.localeCompare(right.id))[0] ?? null;
}

export function implementationCompletionReadiness(input: Readonly<{
  personalCompletion: PersonalCompletion | null;
  artifactVersions: readonly Readonly<{ kind: string; state: string; version: number }>[];
  workflows: readonly Readonly<{
    lifecycleState: string;
    testStatus: string;
    launchDate: string | null;
  }>[];
}>): Readonly<
  | { ready: true }
  | { ready: false; reason: "course_incomplete" | "artifacts_incomplete" | "workflows_incomplete" }
> {
  if (input.personalCompletion === null) return Object.freeze({ ready: false, reason: "course_incomplete" });
  const requiredKinds = new Set([
    "readiness_map", "ai_policy", "workflow_portfolio", "enablement_checklist", "roadmap",
  ]);
  if (
    input.artifactVersions.length !== 5
    || new Set(input.artifactVersions.map(({ kind }) => kind)).size !== 5
    || input.artifactVersions.some(({ kind, state, version }) =>
      !requiredKinds.has(kind) || state !== "final" || !Number.isInteger(version) || version < 1)
  ) {
    return Object.freeze({ ready: false, reason: "artifacts_incomplete" });
  }
  if (
    input.workflows.length !== 3
    || input.workflows.some((workflow) =>
      workflow.lifecycleState !== "live"
      || workflow.testStatus !== "passed"
      || workflow.launchDate === null)
  ) return Object.freeze({ ready: false, reason: "workflows_incomplete" });
  return Object.freeze({ ready: true });
}
