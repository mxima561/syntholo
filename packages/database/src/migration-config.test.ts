import { describe, expect, it } from "vitest";
import { selectMigrationDatabaseUrl } from "./migration-config.js";

describe("selectMigrationDatabaseUrl", () => {
  it("fails closed when a test URL is missing even if production URLs exist", () => {
    expect(() =>
      selectMigrationDatabaseUrl({
        DATABASE_URL: "postgres://production.example/syntholo",
        DATABASE_DIRECT_URL: "postgres://direct.example/syntholo",
        DATABASE_POOLED_URL: "postgres://pooled.example/syntholo",
      }),
    ).toThrow("TEST_DATABASE_URL_REQUIRED");
  });

  it.each([undefined, "", "test", "  test  "])(
    "selects and trims TEST_DATABASE_URL for target %s",
    (target) => {
      expect(
        selectMigrationDatabaseUrl({
          DATABASE_MIGRATION_TARGET: target,
          TEST_DATABASE_URL: "  postgres://test.example/syntholo_test  ",
          DATABASE_DIRECT_URL: "postgres://direct.example/syntholo",
        }),
      ).toBe("postgres://test.example/syntholo_test");
    },
  );

  it("rejects an unknown nonempty migration target", () => {
    expect(() =>
      selectMigrationDatabaseUrl({
        DATABASE_MIGRATION_TARGET: "staging",
        TEST_DATABASE_URL: "postgres://test.example/syntholo_test",
      }),
    ).toThrow("DATABASE_MIGRATION_TARGET_INVALID");
  });

  it("requires a dedicated direct URL for production and ignores generic URLs", () => {
    expect(() =>
      selectMigrationDatabaseUrl({
        DATABASE_MIGRATION_TARGET: "production",
        DATABASE_URL: "postgres://generic.example/syntholo",
        DATABASE_POOLED_URL: "postgres://pooled.example/syntholo",
      }),
    ).toThrow("DATABASE_DIRECT_URL_REQUIRED");
  });

  it("selects and trims only DATABASE_DIRECT_URL for production", () => {
    expect(
      selectMigrationDatabaseUrl({
        DATABASE_MIGRATION_TARGET: "  production  ",
        DATABASE_URL: "postgres://generic.example/syntholo",
        DATABASE_POOLED_URL: "postgres://pooled.example/syntholo",
        DATABASE_DIRECT_URL: "  postgres://direct.example/syntholo  ",
      }),
    ).toBe("postgres://direct.example/syntholo");
  });
});
