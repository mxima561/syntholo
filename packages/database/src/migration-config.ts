export type MigrationEnvironment = Readonly<
  Record<string, string | undefined>
>;

export function selectMigrationDatabaseUrl(
  environment: MigrationEnvironment,
): string {
  const configuredTarget = environment.DATABASE_MIGRATION_TARGET?.trim();
  const target = configuredTarget === undefined || configuredTarget === ""
    ? "test"
    : configuredTarget;

  if (target === "production") {
    const directUrl = environment.DATABASE_DIRECT_URL?.trim();
    if (directUrl === undefined || directUrl === "") {
      throw new Error("DATABASE_DIRECT_URL_REQUIRED");
    }
    return directUrl;
  }

  if (target !== "test") {
    throw new Error("DATABASE_MIGRATION_TARGET_INVALID");
  }

  const testUrl = environment.TEST_DATABASE_URL?.trim();
  if (testUrl === undefined || testUrl === "") {
    throw new Error("TEST_DATABASE_URL_REQUIRED");
  }
  return testUrl;
}
