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

export function createTestMigrationEnvironment(
  environment: TestDatabaseEnvironment,
): Record<string, string | undefined> {
  const sanitized = { ...environment };
  delete sanitized.DATABASE_URL;
  delete sanitized.DATABASE_DIRECT_URL;
  delete sanitized.DATABASE_POOLED_URL;
  sanitized.DATABASE_MIGRATION_TARGET = "test";
  sanitized.TEST_DATABASE_URL = requireTestDatabaseUrl(environment).trim();
  return sanitized;
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
    alter table audit_events disable trigger audit_events_append_only_rows;
    alter table audit_events disable trigger audit_events_append_only_truncate;
    alter table access_decision_audit disable trigger access_decision_audit_append_only_rows;
    alter table access_decision_audit disable trigger access_decision_audit_append_only_truncate;
    alter table seat_invitations disable trigger seat_invitations_append_only_rows;
    alter table seat_invitations disable trigger seat_invitations_append_only_truncate;
    alter table entitlement_sources disable trigger entitlement_sources_append_only_delete;
    alter table entitlement_grants disable trigger entitlement_grants_append_only_delete;
    alter table account_hold_sources disable trigger account_hold_sources_append_only_delete;
    alter table account_holds disable trigger account_holds_append_only_delete;
    alter table seat_invitation_token_generations disable trigger seat_invitation_tokens_append_only_delete;
    alter table seat_reservations disable trigger seat_reservations_append_only_delete
    ; alter table entitlement_commands disable trigger entitlement_commands_append_only_rows
    ; alter table entitlement_commands disable trigger entitlement_commands_append_only_truncate
    ; alter table club_subscription_cancellations disable trigger club_subscription_cancellations_append_only_rows
    ; alter table club_subscription_cancellations disable trigger club_subscription_cancellations_append_only_truncate
    ; alter table business_os_subscription_cancellations disable trigger business_os_subscription_cancellations_append_only_rows
    ; alter table business_os_subscription_cancellations disable trigger business_os_subscription_cancellations_append_only_truncate
    ; alter table business_os_setup_receipts disable trigger business_os_setup_receipts_append_only_delete
    ; alter table business_os_setup_receipts disable trigger business_os_setup_receipts_transition_guard
    ; alter table commerce_fulfillment_receipts disable trigger commerce_fulfillment_receipts_append_only_delete
    ; alter table commerce_fulfillment_receipts disable trigger commerce_fulfillment_receipts_transition_guard
    ; alter table commerce_reconciliations disable trigger commerce_reconciliations_transition_guard
    ; alter table commerce_reconciliations disable trigger commerce_reconciliations_append_only_delete
    ; alter table administrative_grant_restorations disable trigger administrative_grant_restorations_append_only_rows
    ; alter table administrative_grant_restorations disable trigger administrative_grant_restorations_append_only_truncate
  `);
  try {
  await database.pool.query(`
    truncate table
      access_decision_audit,
      entitlement_commands,
      club_subscription_cancellations,
      business_os_subscription_cancellations,
      business_os_setup_receipts,
      commerce_fulfillment_receipts,
      commerce_reconciliations,
      administrative_grant_restorations,
      seat_invitation_token_generations,
      seat_reservations,
      seat_invitations,
      account_holds,
      account_hold_sources,
      entitlement_grants,
      entitlement_sources,
      event_handler_receipts,
      job_attempts,
      staff_login_attempts,
      staff_sessions,
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
  } finally {
    await database.pool.query(`
      alter table audit_events enable always trigger audit_events_append_only_rows;
      alter table audit_events enable always trigger audit_events_append_only_truncate;
      alter table access_decision_audit enable always trigger access_decision_audit_append_only_rows;
      alter table access_decision_audit enable always trigger access_decision_audit_append_only_truncate;
      alter table seat_invitations enable always trigger seat_invitations_append_only_rows;
      alter table seat_invitations enable always trigger seat_invitations_append_only_truncate;
      alter table entitlement_sources enable always trigger entitlement_sources_append_only_delete;
      alter table entitlement_grants enable always trigger entitlement_grants_append_only_delete;
      alter table account_hold_sources enable always trigger account_hold_sources_append_only_delete;
      alter table account_holds enable always trigger account_holds_append_only_delete;
      alter table seat_invitation_token_generations enable always trigger seat_invitation_tokens_append_only_delete;
      alter table seat_reservations enable always trigger seat_reservations_append_only_delete
      ; alter table entitlement_commands enable always trigger entitlement_commands_append_only_rows
      ; alter table entitlement_commands enable always trigger entitlement_commands_append_only_truncate
      ; alter table club_subscription_cancellations enable always trigger club_subscription_cancellations_append_only_rows
      ; alter table club_subscription_cancellations enable always trigger club_subscription_cancellations_append_only_truncate
      ; alter table business_os_subscription_cancellations enable always trigger business_os_subscription_cancellations_append_only_rows
      ; alter table business_os_subscription_cancellations enable always trigger business_os_subscription_cancellations_append_only_truncate
      ; alter table business_os_setup_receipts enable always trigger business_os_setup_receipts_append_only_delete
      ; alter table business_os_setup_receipts enable always trigger business_os_setup_receipts_transition_guard
      ; alter table commerce_fulfillment_receipts enable always trigger commerce_fulfillment_receipts_append_only_delete
      ; alter table commerce_fulfillment_receipts enable always trigger commerce_fulfillment_receipts_transition_guard
      ; alter table commerce_reconciliations enable always trigger commerce_reconciliations_transition_guard
      ; alter table commerce_reconciliations enable always trigger commerce_reconciliations_append_only_delete
      ; alter table administrative_grant_restorations enable always trigger administrative_grant_restorations_append_only_rows
      ; alter table administrative_grant_restorations enable always trigger administrative_grant_restorations_append_only_truncate
    `);
  }
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
