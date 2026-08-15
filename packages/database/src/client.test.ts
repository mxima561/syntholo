import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createDatabase } from "./client.js";

const unusedDatabaseUrl = "postgres://test:test@127.0.0.1:1/not_used";

describe("createDatabase", () => {
  it("keeps the TypeScript system capability allowlist identical to the SQL attestation", async () => {
    const [clientSource, migration] = await Promise.all([
      readFile(new URL("./client.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0012_implementation.sql", import.meta.url), "utf8"),
    ]);
    const sqlStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.syntholo_attest_runtime_capability");
    const sqlEnd = migration.indexOf("WITH source AS (", sqlStart);
    const clientStart = clientSource.indexOf("p.oid::regprocedure::text not in (");
    const clientEnd = clientSource.indexOf("))) or (n.nspname = 'public'", clientStart);
    const signatures = (source: string) => [...source.matchAll(/'(syntholo_[^']+\([^']*\))'/gu)]
      .map((match) => match[1]!)
      .sort();
    const sqlAllowlist = signatures(migration.slice(sqlStart, sqlEnd));
    const clientAllowlist = signatures(clientSource.slice(clientStart, clientEnd));

    expect(sqlStart).toBeGreaterThanOrEqual(0);
    expect(clientStart).toBeGreaterThanOrEqual(0);
    expect(sqlAllowlist).toHaveLength(27);
    expect(clientAllowlist).toEqual(sqlAllowlist);
  });

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

  it.each([
    "host",
    "hostaddr",
    "port",
    "user",
    "password",
    "database",
    "dbname",
    "options",
    "replication",
    "service",
    "application_name",
    "fallback_application_name",
  ])("rejects the reserved PostgreSQL query key %s without exposing credentials", (key) => {
    const credential = "query-secret";
    const url = `postgres://url_user:${credential}@validated.example/database?${key}=override`;

    let error: unknown;
    try {
      createDatabase({ url, applicationName: "database-unit-test" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toEqual(new Error("DATABASE_URL_INVALID"));
    expect(String(error)).not.toContain(credential);
    expect(String(error)).not.toContain(url);
  });

  it.each([
    "%68ost=override.example",
    "%6fptions=override",
    "%72eplication=true",
    "APPLICATION_NAME=override-name",
    "OPTIONS=override",
    "REPLICATION=true",
    "sslmode=require&options=first&options=second",
    "sslmode=require&host=first.example&host=second.example",
  ])("rejects an encoded, case-varied, or duplicate reserved query key: %s", (query) => {
    const credential = "variant-secret";
    const url = `postgres://url_user:${credential}@validated.example/database?${query}`;

    let error: unknown;
    try {
      createDatabase({ url, applicationName: "database-unit-test" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toEqual(new Error("DATABASE_URL_INVALID"));
    expect(String(error)).not.toContain(credential);
    expect(String(error)).not.toContain(url);
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

  it("overrides hostile ambient PGOPTIONS with fail-closed startup settings", async () => {
    const original = process.env.PGOPTIONS;
    process.env.PGOPTIONS =
      "-c row_security=off -c app.account_id=10000000-0000-4000-8000-000000000001";

    try {
      const database = createDatabase({
        url: unusedDatabaseUrl,
        applicationName: "database-unit-test",
      });

      expect(database.pool.options.options).toBe(
        "-c row_security=on -c app.account_id=",
      );
      expect(database.pool.totalCount).toBe(0);
      await database.close();
    } finally {
      if (original === undefined) {
        delete process.env.PGOPTIONS;
      } else {
        process.env.PGOPTIONS = original;
      }
    }
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
