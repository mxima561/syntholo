import { describe, expect, it } from "vitest";
import { requireTestDatabaseUrl } from "./database.js";

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
