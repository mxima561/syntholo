import type { DatabaseCapability } from "./client.js";

type ReadinessDatabase = Readonly<{
  pool: Readonly<{
    query(sql: string): Promise<Readonly<{
      rows: Array<{
        capability: string | null;
        migration_count: number;
        runtime_role: string;
        schema_version: string;
      }>;
    }>>;
  }>;
}>;

export async function checkDatabaseReadiness(
  database: ReadinessDatabase,
  expectedCapability: DatabaseCapability,
): Promise<Readonly<{ latencyMs: number; status: "ok" }>> {
  const started = Date.now();
  try {
    const result = await database.pool.query(
      "select schema_version, migration_count, runtime_role, capability from public.syntholo_runtime_readiness()",
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1
      || row === undefined
      || row.schema_version !== "0006_runtime_readiness"
      || row.migration_count !== 6
      || row.capability !== expectedCapability
      || row.runtime_role.trim() === ""
    ) {
      throw new Error("projection mismatch");
    }
    return { latencyMs: Date.now() - started, status: "ok" };
  } catch {
    throw new Error("DATABASE_NOT_READY");
  }
}
