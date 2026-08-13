import { describe, expect, it } from "vitest";
import {
  createTestMigrationEnvironment,
  requireTestDatabaseUrl,
} from "./database.js";

describe("requireTestDatabaseUrl", () => {
  it("fails closed without TEST_DATABASE_URL and ignores DATABASE_URL", () => {
    expect(() =>
      requireTestDatabaseUrl({
        DATABASE_URL: "postgres://production.example/syntholo",
      }),
    ).toThrow("TEST_DATABASE_URL_REQUIRED");
  });

  it("returns the explicit test database URL", () => {
    expect(
      requireTestDatabaseUrl({
        DATABASE_URL: "postgres://production.example/syntholo",
        TEST_DATABASE_URL: "postgres://test.example/syntholo_test",
      }),
    ).toBe("postgres://test.example/syntholo_test");
  });
});

describe("createTestMigrationEnvironment", () => {
  it("forces the test target and removes every production database URL", () => {
    const environment = createTestMigrationEnvironment({
      PATH: "/usr/bin",
      DATABASE_MIGRATION_TARGET: "production",
      TEST_DATABASE_URL: "  postgres://test:test@test.example/test_db  ",
      DATABASE_URL: "postgres://generic:secret@production.example/live",
      DATABASE_DIRECT_URL: "postgres://direct:secret@production.example/live",
      DATABASE_POOLED_URL: "postgres://pooled:secret@production.example/live",
    });

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      DATABASE_MIGRATION_TARGET: "test",
      TEST_DATABASE_URL: "postgres://test:test@test.example/test_db",
    });
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("DATABASE_DIRECT_URL");
    expect(environment).not.toHaveProperty("DATABASE_POOLED_URL");
  });
});
