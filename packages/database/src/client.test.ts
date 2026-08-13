import { describe, expect, it } from "vitest";
import { createDatabase } from "./client.js";

describe("createDatabase", () => {
  it.each(["", "   "])("rejects a blank database URL", (url) => {
    expect(() =>
      createDatabase({ url, applicationName: "database-unit-test" }),
    ).toThrow("DATABASE_URL_REQUIRED");
  });

  it.each(["", "   "])("rejects a blank application name", (applicationName) => {
    expect(() =>
      createDatabase({
        url: "postgres://127.0.0.1:1/not-used",
        applicationName,
      }),
    ).toThrow("DATABASE_APPLICATION_NAME_REQUIRED");
  });

  it("does not open a connection before the first query", async () => {
    const database = createDatabase({
      url: "postgres://127.0.0.1:1/not-used",
      applicationName: "database-unit-test",
    });

    expect(database.pool.totalCount).toBe(0);

    await database.close();
  });

  it("exposes relational queries for the foundation schema", async () => {
    const database = createDatabase({
      url: "postgres://127.0.0.1:1/not-used",
      applicationName: "database-unit-test",
    });

    expect(database.query.accounts.findMany).toBeTypeOf("function");

    await database.close();
  });
});
