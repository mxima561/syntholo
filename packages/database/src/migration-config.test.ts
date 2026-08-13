import { describe, expect, it } from "vitest";
import { selectMigrationDatabaseUrl } from "./migration-config.js";

describe("selectMigrationDatabaseUrl", () => {
  it("fails closed when a test URL is missing even if DATABASE_URL exists", () => {
    expect(() =>
      selectMigrationDatabaseUrl({
        DATABASE_URL: "postgres://production.example/syntholo",
      }),
    ).toThrow("TEST_DATABASE_URL_REQUIRED");
  });

  it("uses DATABASE_URL only when the production target is explicit", () => {
    expect(
      selectMigrationDatabaseUrl({
        DATABASE_MIGRATION_TARGET: "production",
        DATABASE_URL: "postgres://production.example/syntholo",
      }),
    ).toBe("postgres://production.example/syntholo");
  });
});
