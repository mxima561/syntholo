import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

async function loadImplementationSchema() {
  return import("./implementation.js").catch(() => null);
}

describe("implementation persistence schema", () => {
  it("publishes stable roots, immutable versions, normalized workflows, and completion snapshots", async () => {
    const schema = await loadImplementationSchema();
    expect(schema, "implementation schema must exist").not.toBeNull();
    if (schema === null) return;

    expect(Object.keys(schema).sort()).toEqual([
      "implementationArtifactVersions",
      "implementationArtifacts",
      "implementationCompletionArtifactSnapshots",
      "implementationCompletionWorkflowSnapshots",
      "implementationCompletions",
      "implementationWorkflows",
    ]);
    expect(schema.implementationArtifacts.accountId.name).toBe("account_id");
    expect(schema.implementationArtifactVersions.creatorMembershipId.name).toBe("creator_membership_id");
    expect(schema.implementationWorkflows.testStatus.name).toBe("test_status");
    expect(schema.implementationCompletions.courseCompletionId.name).toBe("course_completion_id");

    const roots = getTableConfig(schema.implementationArtifacts);
    const versions = getTableConfig(schema.implementationArtifactVersions);
    const workflows = getTableConfig(schema.implementationWorkflows);
    const currentHead = roots.foreignKeys.find((key) =>
      key.getName() === "implementation_artifacts_current_version_fk"
    );
    expect(currentHead).toBeDefined();
    expect(currentHead?.reference().columns.map(({ name }) => name)).toEqual([
      "current_version_id", "account_id", "course_id", "id", "kind", "current_version",
    ]);
    expect(currentHead?.reference().foreignColumns.map(({ name }) => name)).toEqual([
      "id", "account_id", "course_id", "artifact_id", "kind", "version",
    ]);
    expect(versions.uniqueConstraints.map(({ name }) => name)).toContain(
      "implementation_versions_source_command_receipt_id_unique",
    );
    expect(versions.indexes.map(({ config: { name } }) => name)).toContain(
      "implementation_versions_history_idx",
    );
    expect(roots.checks.map(({ name }) => name).sort()).toEqual([
      "implementation_artifacts_head_check",
      "implementation_artifacts_kind_check",
      "implementation_artifacts_title_check",
    ]);
    expect(versions.checks.map(({ name }) => name).sort()).toEqual([
      "implementation_versions_canonical_check",
      "implementation_versions_canonical_size_check",
      "implementation_versions_content_check",
      "implementation_versions_hash_check",
      "implementation_versions_hash_parity_check",
      "implementation_versions_state_check",
      "implementation_versions_version_check",
    ]);
    expect(workflows.checks.map(({ name }) => name).sort()).toEqual([
      "implementation_workflows_arrays_check",
      "implementation_workflows_artifact_kind_check",
      "implementation_workflows_engine_check",
      "implementation_workflows_lifecycle_check",
      "implementation_workflows_live_check",
      "implementation_workflows_ordinal_check",
      "implementation_workflows_test_check",
      "implementation_workflows_text_check",
    ]);
  });
});
