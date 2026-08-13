import {
  accounts,
  createDatabase,
  migrateDatabase,
  type Database,
} from "@syntholo/database";

export type TestDatabaseEnvironment = Readonly<
  Record<string, string | undefined>
>;

export function requireTestDatabaseUrl(
  environment: TestDatabaseEnvironment,
): string {
  const url = environment.TEST_DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new Error("TEST_DATABASE_URL_REQUIRED");
  }
  return url;
}

let factorySequence = 0;

function nextUuid(): string {
  factorySequence += 1;
  return `00000000-0000-4000-8000-${String(factorySequence).padStart(12, "0")}`;
}

export const databaseFactories = {
  async account(
    database: Database,
    patch: Partial<typeof accounts.$inferInsert> = {},
  ): Promise<string> {
    const id = patch.id ?? nextUuid();
    await database.insert(accounts).values({
      id,
      name: `Test account ${id}`,
      ...patch,
    });
    return id;
  },

  async memberIdentity(
    database: Database,
    input: Readonly<{
      accountId: string;
      provider?: string;
      providerUserId?: string;
    }>,
  ): Promise<string> {
    const id = nextUuid();
    await database.pool.query(
      `insert into member_identities
        (id, account_id, provider, provider_user_id)
       values ($1, $2, $3, $4)`,
      [
        id,
        input.accountId,
        input.provider ?? "clerk",
        input.providerUserId ?? `user_${id}`,
      ],
    );
    return id;
  },

  async providerReceipt(
    database: Database,
    input: Readonly<{ provider?: string; eventId?: string }> = {},
  ): Promise<string> {
    const id = nextUuid();
    await database.pool.query(
      `insert into provider_event_receipts
        (id, provider, provider_event_id)
       values ($1, $2, $3)`,
      [
        id,
        input.provider ?? "stripe",
        input.eventId ?? `event_${id}`,
      ],
    );
    return id;
  },
};

export type DatabaseFactories = typeof databaseFactories;

export async function resetTestDatabase(database: Database): Promise<void> {
  await database.pool.query(`
    truncate table
      provider_event_receipts,
      jobs,
      outbox_events,
      audit_events,
      memberships,
      member_identities,
      staff_identities,
      accounts
    restart identity cascade
  `);
  factorySequence = 0;
}

export type TestDatabaseHarness = Readonly<{
  database: Database;
  factories: DatabaseFactories;
  reset(): Promise<void>;
  close(): Promise<void>;
}>;

export async function createTestDatabaseHarness(
  environment: TestDatabaseEnvironment = process.env,
): Promise<TestDatabaseHarness> {
  const database = createDatabase({
    url: requireTestDatabaseUrl(environment),
    applicationName: "syntholo-integration-tests",
  });

  try {
    await migrateDatabase(database);
  } catch (error) {
    await database.close();
    throw error;
  }

  return {
    database,
    factories: databaseFactories,
    reset: () => resetTestDatabase(database),
    close: () => database.close(),
  };
}
