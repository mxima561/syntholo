import { createDatabase } from "./client.js";
import { selectMigrationDatabaseUrl } from "./migration-config.js";
import { migrateDatabase } from "./migrations.js";

declare const __SYNTHOLO_RELEASE_SHA__: string;

async function main(): Promise<void> {
  const artifactReleaseSha = typeof __SYNTHOLO_RELEASE_SHA__ === "string"
    ? __SYNTHOLO_RELEASE_SHA__
    : undefined;
  if (
    artifactReleaseSha !== undefined
    && (!/^[0-9a-f]{40}$/u.test(process.env.RELEASE_SHA ?? "")
      || process.env.RELEASE_SHA !== artifactReleaseSha)
  ) {
    throw new Error("MIGRATION_RELEASE_IDENTITY_INVALID");
  }
  const database = createDatabase({
    applicationName: "syntholo-migrations",
    url: selectMigrationDatabaseUrl(process.env),
  });

  try {
    await migrateDatabase(database);
  } finally {
    await database.close();
  }
}

void main().catch(() => {
  process.stderr.write("MIGRATION_STARTUP_FAILED\n");
  process.exitCode = 1;
});
