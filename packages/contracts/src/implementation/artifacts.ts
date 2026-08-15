import { z } from "zod";

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: false, precision: 3 });
const DateSchema = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const utf8 = new TextEncoder();
function isUnicodeScalarText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0 || (unit >= 0xdc00 && unit <= 0xdfff)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    }
  }
  return true;
}
const boundedCanonicalText = (maxBytes: number) => z.string()
  .refine(isUnicodeScalarText, "Text must contain valid Unicode scalar values")
  .refine((value) => value === value.trim(), "Text must already be trimmed")
  .refine((value) => utf8.encode(value).byteLength <= maxBytes, `Text exceeds ${maxBytes} UTF-8 bytes`);
const TextSchema = boundedCanonicalText(2_000);
const ShortTextSchema = boundedCanonicalText(255);
const TextListSchema = z.array(ShortTextSchema).max(25);

export const ArtifactKindSchema = z.enum([
  "readiness_map",
  "ai_policy",
  "workflow_portfolio",
  "enablement_checklist",
  "roadmap",
]);
export const ArtifactStateSchema = z.enum(["draft", "final"]);
export const WorkflowLifecycleStateSchema = z.enum(["draft", "testing", "live", "paused"]);
export const WorkflowTestStatusSchema = z.enum(["not_started", "in_progress", "passed", "failed"]);

function nonblank(value: string): boolean {
  return value.length > 0;
}

export const WorkflowContentSchema = z.object({
  name: ShortTextSchema,
  engine: z.enum(["growth", "client", "management"]),
  problem: TextSchema,
  trigger: TextSchema,
  owner: ShortTextSchema,
  approvedTools: TextListSchema,
  steps: z.array(TextSchema).max(25),
  humanReviewPoint: TextSchema,
  safetyNotes: TextSchema,
  baseline: ShortTextSchema,
  target: ShortTextSchema,
  lifecycleState: WorkflowLifecycleStateSchema,
  testStatus: WorkflowTestStatusSchema,
  launchDate: DateSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.lifecycleState !== "live") return;
  const complete = [
    value.name,
    value.problem,
    value.trigger,
    value.owner,
    value.humanReviewPoint,
    value.safetyNotes,
    value.baseline,
    value.target,
  ].every(nonblank)
    && value.approvedTools.length > 0
    && value.approvedTools.every(nonblank)
    && value.steps.length > 0
    && value.steps.every(nonblank);
  if (!complete || value.testStatus !== "passed" || value.launchDate === null) {
    context.addIssue({ code: "custom", message: "Live workflow is incomplete" });
  }
});

const ReadinessMapContentSchema = z.object({
  kind: z.literal("readiness_map"),
  priorities: z.array(z.object({
    opportunity: ShortTextSchema,
    currentState: TextSchema,
    targetOutcome: TextSchema,
    owner: ShortTextSchema,
  }).strict()).max(25),
  notes: TextSchema,
}).strict();

const AiPolicyContentSchema = z.object({
  kind: z.literal("ai_policy"),
  purpose: TextSchema,
  approvedUses: TextListSchema,
  prohibitedUses: TextListSchema,
  humanReviewRules: TextListSchema,
}).strict();

const WorkflowPortfolioContentSchema = z.object({
  kind: z.literal("workflow_portfolio"),
  workflows: z.array(WorkflowContentSchema).max(3),
}).strict();

const EnablementChecklistContentSchema = z.object({
  kind: z.literal("enablement_checklist"),
  owner: ShortTextSchema,
  items: z.array(z.object({ label: TextSchema, complete: z.boolean() }).strict()).max(50),
}).strict();

const RoadmapContentSchema = z.object({
  kind: z.literal("roadmap"),
  objective: TextSchema,
  milestones: z.array(z.object({
    horizon: z.enum(["30_days", "60_days", "90_days"]),
    outcome: TextSchema,
    owner: ShortTextSchema,
  }).strict()).max(25),
}).strict();

export const ArtifactContentSchema = z.discriminatedUnion("kind", [
  ReadinessMapContentSchema,
  AiPolicyContentSchema,
  WorkflowPortfolioContentSchema,
  EnablementChecklistContentSchema,
  RoadmapContentSchema,
]);

function finalContentComplete(content: z.infer<typeof ArtifactContentSchema>): boolean {
  switch (content.kind) {
    case "readiness_map":
      return nonblank(content.notes)
        && content.priorities.length > 0
        && content.priorities.every((priority) =>
          [priority.opportunity, priority.currentState, priority.targetOutcome, priority.owner]
            .every(nonblank));
    case "ai_policy":
      return nonblank(content.purpose)
        && content.approvedUses.length > 0
        && content.approvedUses.every(nonblank)
        && content.prohibitedUses.length > 0
        && content.prohibitedUses.every(nonblank)
        && content.humanReviewRules.length > 0
        && content.humanReviewRules.every(nonblank);
    case "workflow_portfolio":
      return content.workflows.length === 3
        && content.workflows.every((workflow) => [
          workflow.name, workflow.problem, workflow.trigger, workflow.owner,
          workflow.humanReviewPoint, workflow.safetyNotes, workflow.baseline, workflow.target,
        ].every(nonblank)
          && workflow.approvedTools.length > 0
          && workflow.approvedTools.every(nonblank)
          && workflow.steps.length > 0
          && workflow.steps.every(nonblank));
    case "enablement_checklist":
      return nonblank(content.owner)
        && content.items.length > 0
        && content.items.every(({ label }) => nonblank(label));
    case "roadmap":
      return nonblank(content.objective)
        && content.milestones.length > 0
        && content.milestones.every(({ outcome, owner }) => nonblank(outcome) && nonblank(owner));
  }
}

export const SaveArtifactVersionRequestSchema = z.object({
  expectedVersion: z.number().int().min(0).max(2_147_483_646),
  state: ArtifactStateSchema,
  content: ArtifactContentSchema,
}).strict().superRefine((value, context) => {
  if (value.state === "final" && !finalContentComplete(value.content)) {
    context.addIssue({ code: "custom", message: "Final artifact is incomplete" });
  }
});

export const ArtifactVersionsQuerySchema = z.object({
  limit: z.preprocess(
    (value) => value === undefined
      ? 25
      : typeof value === "number"
        ? value
        : typeof value === "string" && /^(?:[1-9]|[1-9][0-9]|100)$/u.test(value)
          ? Number(value)
          : value,
    z.number().int().min(1).max(100),
  ),
  cursor: z.string().regex(/^v1\.[A-Za-z0-9_-]{1,512}$/u).optional(),
}).strict();

const ArtifactVersionMetadataSchema = z.object({
  id: UuidSchema,
  version: z.number().int().positive(),
  state: ArtifactStateSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  createdAt: TimestampSchema,
  authorLabel: z.enum(["You", "A teammate"]),
}).strict();

export const ArtifactSummarySchema = z.object({
  id: UuidSchema,
  kind: ArtifactKindSchema,
  title: boundedCanonicalText(255).refine(nonblank, "Title is required"),
  currentVersion: z.number().int().min(0),
  currentState: ArtifactStateSchema.nullable(),
  currentVersionId: UuidSchema.nullable(),
  updatedAt: TimestampSchema.nullable(),
  authorLabel: z.enum(["You", "A teammate"]).nullable(),
}).strict().superRefine((value, context) => {
  const empty = value.currentVersion === 0;
  const related = [
    value.currentState,
    value.currentVersionId,
    value.updatedAt,
    value.authorLabel,
  ];
  if (empty !== related.every((item) => item === null)) {
    context.addIssue({ code: "custom", message: "Artifact head is inconsistent" });
  }
  if (!empty && related.some((item) => item === null)) {
    context.addIssue({ code: "custom", message: "Artifact head is incomplete" });
  }
});

const ImplementationCompletionSchema = z.object({
  completed: z.boolean(),
  completedAt: TimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.completed !== (value.completedAt !== null)) {
    context.addIssue({ code: "custom", message: "Completion timestamp is inconsistent" });
  }
});

export const ArtifactListResponseSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(ArtifactSummarySchema).length(5),
  nextCursor: z.null(),
  implementationCompletion: ImplementationCompletionSchema,
}).strict().superRefine((value, context) => {
  if (
    new Set(value.items.map(({ id }) => id)).size !== 5
    || new Set(value.items.map(({ kind }) => kind)).size !== 5
  ) context.addIssue({ code: "custom", message: "Artifact root set is invalid" });
});

export const ArtifactDetailResponseSchema = z.object({
  schemaVersion: z.literal(1),
  artifact: ArtifactSummarySchema,
  content: ArtifactContentSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.content !== null && value.content.kind !== value.artifact.kind) {
    context.addIssue({ code: "custom", message: "Artifact content kind is inconsistent" });
  }
  if ((value.artifact.currentVersion === 0) !== (value.content === null)) {
    context.addIssue({ code: "custom", message: "Artifact content head is inconsistent" });
  }
  if (
    value.artifact.currentState === "final"
    && value.content !== null
    && !finalContentComplete(value.content)
  ) context.addIssue({ code: "custom", message: "Final artifact response is incomplete" });
});

export const ArtifactVersionsResponseSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(ArtifactVersionMetadataSchema),
  nextCursor: z.string().regex(/^v1\.[A-Za-z0-9_-]{1,512}$/u).nullable(),
}).strict();

export const SaveArtifactVersionResponseSchema = z.object({
  schemaVersion: z.literal(1),
  artifact: ArtifactSummarySchema,
  version: ArtifactVersionMetadataSchema,
  content: ArtifactContentSchema,
  implementationCompletion: ImplementationCompletionSchema,
}).strict().superRefine((value, context) => {
  if (
    value.content.kind !== value.artifact.kind
    || value.artifact.currentVersion !== value.version.version
    || value.artifact.currentVersionId !== value.version.id
    || value.artifact.currentState !== value.version.state
    || value.artifact.updatedAt !== value.version.createdAt
    || value.artifact.authorLabel !== "You"
    || value.version.authorLabel !== "You"
  ) context.addIssue({ code: "custom", message: "Saved artifact response is inconsistent" });
  if (value.version.state === "final" && !finalContentComplete(value.content)) {
    context.addIssue({ code: "custom", message: "Final saved artifact is incomplete" });
  }
});

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactState = z.infer<typeof ArtifactStateSchema>;
export type ArtifactContent = z.infer<typeof ArtifactContentSchema>;
export type WorkflowContent = z.infer<typeof WorkflowContentSchema>;
export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;
export type ArtifactListResponse = z.infer<typeof ArtifactListResponseSchema>;
export type ArtifactDetailResponse = z.infer<typeof ArtifactDetailResponseSchema>;
export type ArtifactVersionsResponse = z.infer<typeof ArtifactVersionsResponseSchema>;
export type SaveArtifactVersionRequest = z.infer<typeof SaveArtifactVersionRequestSchema>;
export type SaveArtifactVersionResponse = z.infer<typeof SaveArtifactVersionResponseSchema>;
