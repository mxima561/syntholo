import { describe, expect, it } from "vitest";

async function loadVersioning() {
  return import("./versioning.js").catch(() => null);
}

const completeWorkflow = (name: string) => ({
  name,
  engine: "growth" as const,
  problem: "Qualified leads wait too long for a response.",
  trigger: "A qualified form is submitted.",
  owner: "Revenue operations lead",
  approvedTools: ["CRM"],
  steps: ["Validate", "Draft", "Approve"],
  humanReviewPoint: "A person approves custom scope language.",
  safetyNotes: "Exclude confidential customer data.",
  baseline: "Nine hours",
  target: "Ten minutes",
  lifecycleState: "live" as const,
  testStatus: "passed" as const,
  launchDate: "2026-08-15",
});

describe("implementation versioning authority", () => {
  it("canonicalizes structured content and rejects stale optimistic writes", async () => {
    const versioning = await loadVersioning();
    expect(versioning, "implementation versioning must exist").not.toBeNull();
    if (versioning === null) return;

    const left = versioning.canonicalizeArtifactContent({
      kind: "ai_policy",
      purpose: "Set safe team boundaries.",
      approvedUses: ["Draft internal summaries"],
      prohibitedUses: ["Make final hiring decisions"],
      humanReviewRules: ["A person approves external claims"],
    });
    const right = versioning.canonicalizeArtifactContent({
      humanReviewRules: ["A person approves external claims"],
      prohibitedUses: ["Make final hiring decisions"],
      approvedUses: ["Draft internal summaries"],
      purpose: "Set safe team boundaries.",
      kind: "ai_policy",
    });
    expect(left).toEqual(right);
    expect(left.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(versioning.nextArtifactVersion(2, 2)).toBe(3);
    expect(() => versioning.nextArtifactVersion(2, 1)).toThrow("VERSION_CONFLICT");
    expect(versioning.nextArtifactVersion(2_147_483_646, 2_147_483_646)).toBe(2_147_483_647);
    expect(() => versioning.nextArtifactVersion(2_147_483_647, 2_147_483_647))
      .toThrow("VERSION_CONFLICT");
  });

  it("requires exactly three complete workflows for a final portfolio without forcing launch", async () => {
    const versioning = await loadVersioning();
    expect(versioning).not.toBeNull();
    if (versioning === null) return;

    const three = [
      { ...completeWorkflow("Growth"), lifecycleState: "draft" as const, testStatus: "not_started" as const, launchDate: null },
      { ...completeWorkflow("Client"), lifecycleState: "testing" as const, testStatus: "in_progress" as const, launchDate: null },
      { ...completeWorkflow("Management"), lifecycleState: "paused" as const, testStatus: "failed" as const, launchDate: null },
    ];
    expect(() => versioning.assertArtifactFinalizable({
      kind: "workflow_portfolio",
      workflows: three,
    })).not.toThrow();
    expect(() => versioning.assertArtifactFinalizable({
      kind: "workflow_portfolio",
      workflows: three.slice(0, 2),
    })).toThrow("IMPLEMENTATION_PORTFOLIO_INCOMPLETE");
    expect(() => versioning.assertArtifactFinalizable({
      kind: "workflow_portfolio",
      workflows: [{ ...three[0]!, owner: "" }, three[1]!, three[2]!],
    })).toThrow("IMPLEMENTATION_PORTFOLIO_INCOMPLETE");
  });

  it("converges artifacts-first and lessons-first to one immutable completion snapshot", async () => {
    const versioning = await loadVersioning();
    expect(versioning).not.toBeNull();
    if (versioning === null) return;

    const artifactVersions = [
      "readiness_map",
      "ai_policy",
      "workflow_portfolio",
      "enablement_checklist",
      "roadmap",
    ].map((kind, index) => ({ kind, state: "final" as const, version: index + 1 }));
    const workflows = ["growth", "client", "management"].map((name) => ({
      name,
      lifecycleState: "live" as const,
      testStatus: "passed" as const,
      launchDate: "2026-08-15",
    }));
    expect(versioning.implementationCompletionReadiness({
      personalCompletion: null,
      artifactVersions,
      workflows,
    })).toEqual({ ready: false, reason: "course_incomplete" });
    expect(versioning.implementationCompletionReadiness({
      personalCompletion: { id: crypto.randomUUID(), completedAt: "2026-08-15T12:00:00.000Z" },
      artifactVersions,
      workflows,
    })).toEqual({ ready: true });
    expect(versioning.implementationCompletionReadiness({
      personalCompletion: { id: crypto.randomUUID(), completedAt: "2026-08-15T12:00:00.000Z" },
      artifactVersions: [...artifactVersions, { kind: "roadmap", state: "draft", version: 6 }],
      workflows,
    })).toEqual({ ready: false, reason: "artifacts_incomplete" });
    expect(versioning.implementationCompletionReadiness({
      personalCompletion: { id: crypto.randomUUID(), completedAt: "2026-08-15T12:00:00.000Z" },
      artifactVersions,
      workflows: [...workflows, { lifecycleState: "paused", testStatus: "passed", launchDate: "2026-08-15" }],
    })).toEqual({ ready: false, reason: "workflows_incomplete" });
    expect(versioning.selectEarliestPersonalCompletion([
      { id: "10000000-0000-4000-8000-000000000002", completedAt: "2026-08-15T12:00:00.000Z" },
      { id: "10000000-0000-4000-8000-000000000001", completedAt: "2026-08-15T12:00:00.000Z" },
      { id: "10000000-0000-4000-8000-000000000003", completedAt: "2026-08-16T12:00:00.000Z" },
    ])?.id).toBe("10000000-0000-4000-8000-000000000001");
  });
});
