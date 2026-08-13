import { describe, expect, it } from "vitest";
import { createDatabase } from "./client.js";

const unusedDatabaseUrl = "postgres://test:test@127.0.0.1:1/not_used";

describe("createDatabase", () => {
  it.each(["", "   "])("rejects a blank database URL", (url) => {
    expect(() =>
      createDatabase({ url, applicationName: "database-unit-test" }),
    ).toThrow("DATABASE_URL_REQUIRED");
  });

  it.each(["", "   "])("rejects a blank application name", (applicationName) => {
    expect(() =>
      createDatabase({
        url: unusedDatabaseUrl,
        applicationName,
      }),
    ).toThrow("DATABASE_APPLICATION_NAME_REQUIRED");
  });

  it("does not open a connection before the first query", async () => {
    const database = createDatabase({
      url: unusedDatabaseUrl,
      applicationName: "database-unit-test",
    });

    expect(database.pool.totalCount).toBe(0);

    await database.close();
  });

  it("exposes relational queries for the foundation schema", async () => {
    const database = createDatabase({
      url: unusedDatabaseUrl,
      applicationName: "database-unit-test",
    });

    expect(database.query.accounts.findMany).toBeTypeOf("function");

    await database.close();
  });

  it.each([
    "not-a-url",
    "https://user:pass@example.com/database",
    "postgres://",
    "postgres://example.com/database",
    "postgres://user@example.com/database",
    "postgres://user:pass@example.com",
    "postgres://user:pass@example.com/",
    "postgres://user:pass%0A@example.com/database",
    "postgres://user:pass@example.com/data base",
  ])("rejects an unsafe or incomplete PostgreSQL URL: %s", (url) => {
    expect(() =>
      createDatabase({ url, applicationName: "database-unit-test" }),
    ).toThrow("DATABASE_URL_INVALID");
  });

  it("trims a complete local URL before configuring the lazy pool", async () => {
    const database = createDatabase({
      url: "  postgres://local_user:local_password@localhost:55432/local_db  ",
      applicationName: "  syntholo-local  ",
    });

    expect(database.pool.options.connectionString).toBe(
      "postgres://local_user:local_password@localhost:55432/local_db",
    );
    expect(database.pool.options.application_name).toBe("syntholo-local");
    expect(database.pool.totalCount).toBe(0);

    await database.close();
  });

  it.each([
    [
      "pooled",
      "postgresql://neondb_owner:p%40ss@ep-example-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    ],
    [
      "direct",
      "postgresql://neondb_owner:p%40ss@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    ],
  ])(
    "preserves Neon-style query parameters for a %s URL",
    async (_style, url) => {
      const database = createDatabase({
        url,
        applicationName: "syntholo-neon",
      });

      expect(database.pool.options.connectionString).toBe(url);
      expect(database.pool.totalCount).toBe(0);

      await database.close();
    },
  );

  it.each([
    "migration\nworker",
    "migration\u0000worker",
    "x".repeat(64),
    "é".repeat(32),
  ])(
    "rejects an invalid PostgreSQL application name",
    (applicationName) => {
      expect(() => createDatabase({ url: unusedDatabaseUrl, applicationName }))
        .toThrow("DATABASE_APPLICATION_NAME_INVALID");
    },
  );
});
