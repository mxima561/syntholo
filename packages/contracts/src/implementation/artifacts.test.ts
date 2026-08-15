import { describe, expect, it } from "vitest";

async function loadImplementationContracts() {
  return import("./artifacts.js").catch(() => null);
}

const workflow = {
  name: "Instant lead response",
  engine: "growth",
  problem: "Qualified leads wait too long for a response.",
  trigger: "A qualified website form is submitted.",
  owner: "Revenue operations lead",
  approvedTools: ["CRM", "Email"],
  steps: ["Validate required fields", "Draft a reply", "Route for approval"],
  humanReviewPoint: "A person approves custom scope language.",
  safetyNotes: "Do not include confidential customer data.",
  baseline: "Nine-hour median response",
  target: "Under ten minutes",
  lifecycleState: "live",
  testStatus: "passed",
  launchDate: "2026-08-15",
} as const;

describe("implementation artifact contracts", () => {
  it("exports strict five-kind structured artifact contracts", async () => {
    const contracts = await loadImplementationContracts();
    expect(contracts, "implementation contracts must exist").not.toBeNull();
    if (contracts === null) return;

    expect(contracts.ArtifactKindSchema.options).toEqual([
      "readiness_map",
      "ai_policy",
      "workflow_portfolio",
      "enablement_checklist",
      "roadmap",
    ]);
    expect(contracts.ArtifactContentSchema.safeParse({
      kind: "workflow_portfolio",
      workflows: [workflow],
    }).success).toBe(true);
    expect(contracts.ArtifactContentSchema.safeParse({
      kind: "workflow_portfolio",
      workflows: [workflow],
      html: "<script>alert(1)</script>",
    }).success).toBe(false);
    expect(contracts.ArtifactContentSchema.safeParse({
      kind: "workflow_portfolio",
      workflows: [{ ...workflow, secretObjectKey: "private/output.json" }],
    }).success).toBe(false);
    expect(contracts.ArtifactContentSchema.safeParse({
      kind: "workflow_portfolio",
      workflows: [{ ...workflow, testStatus: "failed", launchDate: null }],
    }).success).toBe(false);
  });

  it("rejects caller-derived scope and authority on saves", async () => {
    const contracts = await loadImplementationContracts();
    expect(contracts).not.toBeNull();
    if (contracts === null) return;

    const request = {
      expectedVersion: 0,
      state: "draft",
      content: { kind: "workflow_portfolio", workflows: [workflow] },
    } as const;
    expect(contracts.SaveArtifactVersionRequestSchema.parse(request)).toEqual(request);
    for (const injected of [
      { accountId: crypto.randomUUID() },
      { membershipId: crypto.randomUUID() },
      { version: 1 },
      { contentHash: "a".repeat(64) },
      { reviewState: "approved" },
    ]) {
      expect(contracts.SaveArtifactVersionRequestSchema.safeParse({
        ...request,
        ...injected,
      }).success).toBe(false);
    }
    expect(contracts.SaveArtifactVersionRequestSchema.safeParse({
      expectedVersion: 0,
      state: "final",
      content: {
        kind: "ai_policy",
        purpose: "",
        approvedUses: [],
        prohibitedUses: [],
        humanReviewRules: [],
      },
    }).success).toBe(false);
    expect(contracts.SaveArtifactVersionRequestSchema.safeParse({
      ...request,
      expectedVersion: 2_147_483_646,
    }).success).toBe(true);
    expect(contracts.SaveArtifactVersionRequestSchema.safeParse({
      ...request,
      expectedVersion: 2_147_483_647,
    }).success).toBe(false);
  });

  it("uses exact trimmed UTF-8 byte bounds for every editable string", async () => {
    const contracts = await loadImplementationContracts();
    expect(contracts).not.toBeNull();
    if (contracts === null) return;

    const draft = (purpose: string, approvedUses: string[] = []) => ({
      expectedVersion: 0,
      state: "draft",
      content: { kind: "ai_policy", purpose, approvedUses, prohibitedUses: [], humanReviewRules: [] },
    });
    expect(contracts.SaveArtifactVersionRequestSchema.safeParse(draft("é".repeat(1_000))).success).toBe(true);
    expect(contracts.SaveArtifactVersionRequestSchema.safeParse(draft(`${"é".repeat(1_000)}a`)).success).toBe(false);
    expect(contracts.SaveArtifactVersionRequestSchema.safeParse(draft("a", ["é".repeat(127)])).success).toBe(true);
    expect(contracts.SaveArtifactVersionRequestSchema.safeParse(draft("a", [`${"é".repeat(127)}aa`])).success).toBe(false);
    for (const noncanonical of [" lead", "trail ", "\u00a0lead", "trail\ufeff"] as const) {
      expect(contracts.SaveArtifactVersionRequestSchema.safeParse(draft(noncanonical)).success).toBe(false);
    }
    for (const blank of ["\t", "\u00a0", "\ufeff"] as const) {
      expect(contracts.SaveArtifactVersionRequestSchema.safeParse({ ...draft(blank), state: "final" }).success).toBe(false);
    }
    for (const invalidUnicode of ["nul\u0000value", "\ud800", "\udc00"] as const) {
      expect(contracts.SaveArtifactVersionRequestSchema.safeParse(draft(invalidUnicode)).success)
        .toBe(false);
    }
    expect(contracts.SaveArtifactVersionRequestSchema.safeParse(draft("valid 😀 scalar")).success)
      .toBe(true);
    expect(contracts.SaveArtifactVersionRequestSchema.safeParse(draft("\u0085kept")).success)
      .toBe(true);
    expect(contracts.SaveArtifactVersionRequestSchema.safeParse(draft("\u180ekept")).success)
      .toBe(true);
  });

  it("rejects year zero while accepting exact Gregorian leap dates", async () => {
    const contracts = await loadImplementationContracts();
    expect(contracts).not.toBeNull();
    if (contracts === null) return;
    const withDate = (launchDate: string) => ({
      ...workflow,
      launchDate,
    });
    expect(contracts.WorkflowContentSchema.safeParse(withDate("0000-01-01")).success).toBe(false);
    expect(contracts.WorkflowContentSchema.safeParse(withDate("2024-02-29")).success).toBe(true);
    expect(contracts.WorkflowContentSchema.safeParse(withDate("2025-02-29")).success).toBe(false);
  });

  it("binds opaque history cursors to exact pagination", async () => {
    const contracts = await loadImplementationContracts();
    expect(contracts).not.toBeNull();
    if (contracts === null) return;

    expect(contracts.ArtifactVersionsQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(contracts.ArtifactVersionsQuerySchema.parse({ limit: "10", cursor: "v1.opaque-token" }))
      .toEqual({ limit: 10, cursor: "v1.opaque-token" });
    expect(contracts.ArtifactVersionsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(contracts.ArtifactVersionsQuerySchema.safeParse({ limit: "100" }).success).toBe(true);
    expect(contracts.ArtifactVersionsQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(contracts.ArtifactVersionsQuerySchema.safeParse({ limit: "10", extra: "x" }).success).toBe(false);
    for (const limit of ["1e1", "10.0", "0x10", ["10"], " 10"] as const) {
      expect(contracts.ArtifactVersionsQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  });

  it("enforces collection and response cross-field integrity", async () => {
    const contracts = await loadImplementationContracts();
    expect(contracts).not.toBeNull();
    if (contracts === null) return;
    const empty = {
      id: "10000000-0000-4000-8000-000000000001",
      kind: "ai_policy",
      title: "Team AI policy",
      currentVersion: 0,
      currentState: null,
      currentVersionId: null,
      updatedAt: null,
      authorLabel: null,
    } as const;
    expect(contracts.ArtifactListResponseSchema.safeParse({
      schemaVersion: 1,
      artifacts: Array.from({ length: 5 }, () => empty),
      implementationCompletion: { completed: false, completedAt: null },
    }).success).toBe(false);
    expect(contracts.ArtifactListResponseSchema.safeParse({
      schemaVersion: 1,
      items: ["readiness_map", "ai_policy", "workflow_portfolio", "enablement_checklist", "roadmap"]
        .map((kind, index) => ({ ...empty, id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, kind })),
      nextCursor: null,
      implementationCompletion: { completed: false, completedAt: null },
    }).success).toBe(true);
    expect(contracts.ArtifactSummarySchema.safeParse({
      ...empty,
      currentVersion: 1,
    }).success).toBe(false);
    expect(contracts.ArtifactDetailResponseSchema.safeParse({
      schemaVersion: 1,
      artifact: empty,
      content: { kind: "roadmap", objective: "Grow", milestones: [] },
    }).success).toBe(false);
    expect(contracts.ArtifactDetailResponseSchema.safeParse({
      schemaVersion: 1,
      artifact: {
        ...empty,
        currentVersion: 1,
        currentState: "final",
        currentVersionId: "10000000-0000-4000-8000-000000000099",
        updatedAt: "2026-08-15T12:00:00.000Z",
        authorLabel: "You",
      },
      content: {
        kind: "ai_policy",
        purpose: "",
        approvedUses: [],
        prohibitedUses: [],
        humanReviewRules: [],
      },
    }).success).toBe(false);
  });
});
