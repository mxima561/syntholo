import { describe, expect, it, vi } from "vitest";
import { checkDatabaseReadiness } from "./readiness";

describe("database readiness projection", () => {
  it("accepts only the exact journal, schema marker, and runtime capability", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        capability: "syntholo_member_api",
        migration_count: 6,
        runtime_role: "syntholo_member_runtime",
        schema_version: "0006_runtime_readiness",
      }],
    }));

    await expect(checkDatabaseReadiness(
      { pool: { query } },
      "syntholo_member_api",
    )).resolves.toEqual({
      latencyMs: expect.any(Number),
      status: "ok",
    });
    expect(query).toHaveBeenCalledWith(
      "select schema_version, migration_count, runtime_role, capability from public.syntholo_runtime_readiness()",
    );
  });

  it.each([
    { capability: "syntholo_staff_api", migration_count: 6, runtime_role: "member", schema_version: "0006_runtime_readiness" },
    { capability: "syntholo_member_api", migration_count: 5, runtime_role: "member", schema_version: "0006_runtime_readiness" },
    { capability: "syntholo_member_api", migration_count: 6, runtime_role: "member", schema_version: "0005_entitlements" },
  ])("fails a stale or wrong-capability projection closed", async (row) => {
    await expect(checkDatabaseReadiness(
      { pool: { query: async () => ({ rows: [row] }) } },
      "syntholo_member_api",
    )).rejects.toThrow("DATABASE_NOT_READY");
  });
});
