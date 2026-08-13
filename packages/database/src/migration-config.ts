export type MigrationEnvironment = Readonly<
  Record<string, string | undefined>
>;

export function selectMigrationDatabaseUrl(
  environment: MigrationEnvironment,
): string {
  if (environment.DATABASE_MIGRATION_TARGET === "production") {
    const productionUrl = environment.DATABASE_URL;
    if (productionUrl === undefined || productionUrl.trim() === "") {
      throw new Error("DATABASE_URL_REQUIRED");
    }
    return productionUrl;
  }

  const testUrl = environment.TEST_DATABASE_URL;
  if (testUrl === undefined || testUrl.trim() === "") {
    throw new Error("TEST_DATABASE_URL_REQUIRED");
  }
  return testUrl;
}
