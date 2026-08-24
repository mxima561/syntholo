import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./client.js";
import { WaitlistInputError, WaitlistRepository } from "./repositories/waitlist.js";
import {
  createTestDatabaseHarness,
  type TestDatabaseHarness,
} from "../../testing/src/database.js";

function loginUrl(baseUrl: string, roleName: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function formattedRoleSql(
  database: Database,
  template: string,
  values: readonly string[],
): Promise<string> {
  const parameters = values.map((_, index) => `$${index + 1}::text`).join(",");
  const result = await database.pool.query<{ value: string }>(
    `select format($fmt$${template}$fmt$, ${parameters}) value`,
    [...values],
  );
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("TEST_ROLE_SQL_FORMAT_FAILED");
  return value;
}

describe("waitlist storage", () => {
  let harness: TestDatabaseHarness;
  let system: Database | undefined;
  const systemRole = `syntholo_waitlist_system_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    const password = randomUUID();
    await harness.database.pool.query(await formattedRoleSql(
      harness.database,
      "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
      [systemRole, password],
    ));
    await harness.database.pool.query(await formattedRoleSql(
      harness.database,
      "grant syntholo_system_api to %I with inherit true, set false, admin false",
      [systemRole],
    ));
    system = createDatabase({
      url: loginUrl(baseUrl, systemRole, password),
      applicationName: "syntholo-waitlist-test",
    });
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await system?.close();
    if (harness !== undefined) {
      await harness.database.pool.query(await formattedRoleSql(
        harness.database,
        "drop role if exists %I",
        [systemRole],
      )).catch(() => undefined);
      await harness.close();
    }
  });

  it("POSTs an email through the repository and reads it back from the database", async () => {
    if (system === undefined) throw new Error("SYSTEM_DATABASE_REQUIRED");
    const waitlist = new WaitlistRepository(system);
    const email = `owner+${randomUUID().slice(0, 8)}@example.test`;
    const created = await waitlist.subscribe({ email, source: "school", correlationId: randomUUID() });
    expect(created.status).toBe("subscribed");
    expect(created.email).toBe(email.toLowerCase());
    expect(created.source).toBe("school");
    const stored = await waitlist.getByEmail({ email: email.toUpperCase(), correlationId: randomUUID() });
    expect(stored).toEqual({
      email: created.email,
      createdAt: created.createdAt,
      source: "school",
    });
    const duplicate = await waitlist.subscribe({
      email: email.toUpperCase(),
      source: "school",
      correlationId: randomUUID(),
    });
    expect(duplicate.status).toBe("already-subscribed");
    expect(duplicate.createdAt).toBe(created.createdAt);
  });

  it("rejects a non-school source before writing", async () => {
    if (system === undefined) throw new Error("SYSTEM_DATABASE_REQUIRED");
    const waitlist = new WaitlistRepository(system);
    await expect(waitlist.subscribe({
      email: "owner@example.test",
      source: "agency",
      correlationId: randomUUID(),
    })).rejects.toBeInstanceOf(WaitlistInputError);
    expect(await waitlist.getByEmail({
      email: "owner@example.test",
      correlationId: randomUUID(),
    })).toBeNull();
  });
});
