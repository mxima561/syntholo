import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createDatabase } from "../client.js";
import {
  createTestDatabaseHarness,
  type TestDatabaseHarness,
} from "../../../testing/src/database.js";

const execFileAsync = promisify(execFile);

describe("foundation migration", () => {
  let harness: TestDatabaseHarness;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("applies the foundation migration through the workspace script", async () => {
    const first = await execFileAsync("npm", ["run", "db:migrate"], {
      cwd: process.cwd(),
      env: process.env,
    });
    const rerun = await execFileAsync("npm", ["run", "db:migrate"], {
      cwd: process.cwd(),
      env: process.env,
    });

    expect(first.stderr).toBe("");
    expect(rerun.stderr).toBe("");
  });

  it("creates all eight foundation tables", async () => {
    const result = await harness.database.pool.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public'
         and table_name = any($1::text[])
       order by table_name`,
      [[
        "accounts",
        "audit_events",
        "jobs",
        "member_identities",
        "memberships",
        "outbox_events",
        "provider_event_receipts",
        "staff_identities",
      ]],
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "accounts",
      "audit_events",
      "jobs",
      "member_identities",
      "memberships",
      "outbox_events",
      "provider_event_receipts",
      "staff_identities",
    ]);
  });

  it("sets the configured PostgreSQL application name", async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (url === undefined) {
      throw new Error("TEST_DATABASE_URL_REQUIRED");
    }
    const database = createDatabase({
      url,
      applicationName: "syntholo-foundation-integration",
    });

    try {
      const result = await database.pool.query<{ application_name: string }>(
        "select current_setting('application_name') as application_name",
      );
      expect(result.rows[0]?.application_name).toBe(
        "syntholo-foundation-integration",
      );
    } finally {
      await database.close();
    }
  });

  it("enforces provider identity and event uniqueness", async () => {
    const accountId = await harness.factories.account(harness.database);
    await harness.factories.memberIdentity(harness.database, {
      accountId,
      provider: "clerk",
      providerUserId: "user_1",
    });

    await expect(
      harness.factories.memberIdentity(harness.database, {
        accountId,
        provider: "clerk",
        providerUserId: "user_1",
      }),
    ).rejects.toMatchObject({ code: "23505" });

    await harness.factories.providerReceipt(harness.database, {
      provider: "stripe",
      eventId: "evt_1",
    });
    await expect(
      harness.factories.providerReceipt(harness.database, {
        provider: "stripe",
        eventId: "evt_1",
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects changing the account of a customer identity", async () => {
    const firstAccountId = await harness.factories.account(harness.database, {
      name: "First account",
    });
    const secondAccountId = await harness.factories.account(harness.database, {
      name: "Second account",
    });
    const identityId = await harness.factories.memberIdentity(harness.database, {
      accountId: firstAccountId,
      provider: "clerk",
      providerUserId: "immutable_user",
    });

    await expect(
      harness.database.pool.query(
        "update member_identities set account_id = $1 where id = $2",
        [secondAccountId, identityId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
