import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const fixtureUrl = new URL("./implementation-handshake.json", import.meta.url);
const migrationUrl = new URL("../../drizzle/0012_implementation.sql", import.meta.url);

describe("implementation schema handshake", () => {
  it("freezes the exact downstream schema and non-certificate authority contract", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Record<string, unknown>;
    const migration = await readFile(migrationUrl, "utf8");
    const hash = createHash("sha256").update(migration).digest("hex");

    expect(fixture).toEqual({
      schemaVersion: 1,
      migration: {
        index: 11,
        timestamp: 1786856400000,
        tag: "0012_implementation",
        sha256: "dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9",
      },
      root: {
        table: "implementation_artifacts",
        primaryKey: ["id"],
        scopeUnique: ["account_id", "course_id", "kind"],
        exactOwnerKey: ["id", "account_id", "course_id"],
        kindOwnerKey: ["id", "account_id", "course_id", "kind"],
        currentVersionForeignKey: ["current_version_id", "account_id", "course_id", "id", "kind", "current_version"],
        kinds: ["readiness_map", "ai_policy", "workflow_portfolio", "enablement_checklist", "roadmap"],
      },
      version: {
        table: "implementation_artifact_versions",
        primaryKey: ["id"],
        immutableOwnerKey: ["account_id", "artifact_id", "id"],
        states: ["draft", "final"],
      },
      workflow: {
        table: "implementation_workflows",
        immutableOwnerKey: ["account_id", "artifact_id", "id"],
        lifecycleStates: ["draft", "testing", "live", "paused"],
        testStatuses: ["not_started", "in_progress", "passed", "failed"],
      },
      completion: {
        table: "implementation_completions",
        primaryKey: ["id"],
        scopeUnique: ["account_id", "course_id"],
        exactOwnerKey: ["id", "account_id", "course_id"],
        artifactSnapshotPrimaryKey: ["completion_id", "artifact_id"],
        workflowSnapshotPrimaryKey: ["completion_id", "workflow_id"],
      },
      seedSystemFunction: {
        signature: "public.syntholo_implementation_seed_workspace_v1(uuid)",
        role: "syntholo_system_api",
      },
      events: {
        consumed: [{ type: "learning.course_completed.v1", schemaVersion: 1 }],
        emitted: [
          { type: "implementation.artifact_version_saved.v1", schemaVersion: 1 },
          { type: "implementation.program_completed.v1", schemaVersion: 1 },
        ],
      },
      certificateAuthority: {
        implementationCompletionIsAuthority: false,
        certificateEligibilityEvent: "learning.course_completed.v1",
      },
    });
    expect(fixture.migration).toMatchObject({ sha256: hash });
    for (const required of [
      "implementation_artifacts_account_course_kind_unique UNIQUE(account_id,course_id,kind)",
      "implementation_artifacts_exact_unique UNIQUE(id,account_id,course_id)",
      "implementation_artifacts_kind_exact_unique UNIQUE(id,account_id,course_id,kind)",
      "implementation_versions_exact_unique UNIQUE(account_id,artifact_id,id)",
      "implementation_workflows_exact_unique UNIQUE(account_id,artifact_id,id)",
      "implementation_completions_account_course_unique UNIQUE(account_id,course_id)",
      "implementation_completions_exact_unique UNIQUE(id,account_id,course_id)",
      "implementation_completion_artifact_snapshots_pkey PRIMARY KEY(completion_id,artifact_id)",
      "implementation_completion_workflow_snapshots_pkey PRIMARY KEY(completion_id,workflow_id)",
      "GRANT EXECUTE ON FUNCTION public.syntholo_implementation_seed_workspace_v1(uuid) TO syntholo_system_api",
      "implementation.artifact_version_saved.v1",
      "implementation.program_completed.v1",
      "learning.course_completed.v1",
    ]) expect(migration).toContain(required);
  });
});
