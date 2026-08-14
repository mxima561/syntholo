import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import {
  type MemberActor,
  type StaffActor,
} from "@syntholo/domain";
import { registerTrustedActorAuthentication } from
  "../../domain/src/identity/authentication.js";
import {
  createTestDatabaseHarness,
  type TestDatabaseHarness,
} from "../../testing/src/database.js";
import {
  attestSystemDatabase,
  createDatabase,
  createSystemUnitOfWork,
  createUnitOfWork,
  databaseErrorCode,
  MemberEntitlementReadRepository,
  migrateDatabase,
  type Database,
  type EntitlementCommandOutcome,
  type ProductFulfillmentValue,
} from "./index.js";

const accountA = "10000000-0000-4000-8000-000000000001";
const accountB = "20000000-0000-4000-8000-000000000002";
let identityA = "10000000-0000-4000-8000-000000000011";
let membershipA = "10000000-0000-4000-8000-000000000021";
const sourceA = "10000000-0000-4000-8000-000000000031";
const grantCourseA = "10000000-0000-4000-8000-000000000041";
const grantSupportA = "10000000-0000-4000-8000-000000000042";
const grantCircleA = "10000000-0000-4000-8000-000000000043";
const now = new Date("2026-08-13T12:00:00.123Z");

function trustedMemberActor<T extends MemberActor>(actor: T): T {
  return registerTrustedActorAuthentication(actor, actor.authenticatedAt);
}

function trustedStaffActor<T extends StaffActor>(actor: T): T {
  return registerTrustedActorAuthentication(actor, actor.authenticatedAt);
}

type AppliedValue<T> = T extends ProductFulfillmentValue
  ? Extract<T, { fulfillmentStatus: "fulfilled" }>
  : T extends { disputeStatus: string }
    ? Extract<T, { disputeStatus: "held" }>
  : Readonly<T>;

function applied<T>(outcome: EntitlementCommandOutcome<T>): AppliedValue<T> {
  expect(outcome.status).toBe("applied");
  if (outcome.status !== "applied") throw new Error("EXPECTED_APPLIED_OUTCOME");
  if ("fulfillmentStatus" in (outcome.value as object)
    && (outcome.value as { fulfillmentStatus?: unknown }).fulfillmentStatus
      === "reconciliation") {
    throw new Error("EXPECTED_FULFILLED_OUTCOME");
  }
  if ("disputeStatus" in (outcome.value as object)
    && (outcome.value as { disputeStatus?: unknown }).disputeStatus
      === "reconciliation") {
    throw new Error("EXPECTED_DISPUTE_HOLD_OUTCOME");
  }
  return outcome.value as AppliedValue<T>;
}

function reconciled(
  outcome: EntitlementCommandOutcome<ProductFulfillmentValue>,
): Extract<ProductFulfillmentValue, { reconciliationKind: "parked_receipt" }> {
  expect(outcome.status).toBe("applied");
  if (outcome.status !== "applied"
    || outcome.value.fulfillmentStatus !== "reconciliation"
    || outcome.value.reconciliationKind !== "parked_receipt") {
    throw new Error("EXPECTED_RECONCILIATION_OUTCOME");
  }
  return outcome.value;
}

type BusinessOsSetupValue = Awaited<ReturnType<
  import("./repositories/entitlements.js").TransactionEntitlementRepository[
    "recordBusinessOsSetupPurchase"
  ]
>> extends EntitlementCommandOutcome<infer T> ? T : never;

function recordedSetup(
  outcome: EntitlementCommandOutcome<BusinessOsSetupValue>,
): Extract<BusinessOsSetupValue, { setupKind: "recorded" | "parked_receipt" }> {
  expect(outcome.status).toBe("applied");
  if (outcome.status !== "applied" || outcome.value.setupKind === "provider_collision") {
    throw new Error("EXPECTED_RECORDED_SETUP_OUTCOME");
  }
  return outcome.value;
}

type RuntimeLogin = Readonly<{
  capability: "syntholo_member_api" | "syntholo_staff_api" | "syntholo_system_api" | "syntholo_worker";
  database: Database;
  roleName: string;
}>;

function loginUrl(baseUrl: string, roleName: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  url.search = "";
  return url.toString();
}

async function formatSql(pool: Pool, template: string, values: string[]): Promise<string> {
  const placeholders = values.map((_, index) => `$${index + 1}::text`).join(",");
  const result = await pool.query<{ value: string }>(
    `select format($fmt$${template}$fmt$, ${placeholders}) as value`,
    values,
  );
  return result.rows[0]!.value;
}

async function runtimeLogin(
  owner: Database,
  baseUrl: string,
  kind: string,
  capability: RuntimeLogin["capability"],
): Promise<RuntimeLogin> {
  const roleName = `syntholo_task8_${kind}_${process.pid}`;
  const password = randomUUID();
  await owner.pool.query(await formatSql(
    owner.pool,
    "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
    [roleName, password],
  ));
  await owner.pool.query(await formatSql(
    owner.pool,
    `grant ${capability} to %I with inherit true, set false, admin false`,
    [roleName],
  ));
  return {
    capability,
    roleName,
    database: createDatabase({
      url: loginUrl(baseUrl, roleName, password),
      applicationName: `syntholo-task8-${kind}`,
    }),
  };
}

async function dropLogin(owner: Database, login: RuntimeLogin): Promise<void> {
  await login.database.close();
  await owner.pool.query(await formatSql(
    owner.pool,
    `revoke ${login.capability} from %I`,
    [login.roleName],
  ));
  await owner.pool.query(await formatSql(owner.pool, "drop role %I", [login.roleName]));
}

async function seedUnclaimedAccount(owner: Database, accountId: string): Promise<void> {
  const client = await owner.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "insert into accounts (id,name) values ($1,$2)",
      [accountId, `Account ${accountId}`],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function inTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedAcademyBundle(owner: Database, accountId = accountA): Promise<void> {
  await inTransaction(owner.pool, async (client) => {
    await client.query(
      `insert into entitlement_sources
        (id,account_id,source_kind,source_id,offer_code,provenance,created_at)
       values ($1,$2,'purchase','purchase-academy','self_paced','test',$3)`,
      [sourceA, accountId, now],
    );
    await client.query(
      `insert into entitlement_grants
      (id,account_id,source_registry_id,source_kind,source_id,offer_code,
       capability,status,starts_at,ends_at,provenance,created_at,updated_at)
     values
      ($1,$4,$5,'purchase','purchase-academy','self_paced','academy_course','active',$6,null,'test',$6,$6),
      ($2,$4,$5,'purchase','purchase-academy','self_paced','support','active',$6,$7,'test',$6,$6),
      ($3,$4,$5,'purchase','purchase-academy','self_paced','circle_write','active',$6,$7,'test',$6,$6)
    `,
      [grantCourseA, grantSupportA, grantCircleA, accountId, sourceA,
        new Date("2025-08-13T12:00:00.123Z"), now],
    );
    await client.query(
      `insert into seat_reservations
        (account_id,slot,source_registry_id,state,membership_id,created_at,updated_at)
       select $1,1,$2,'active',m.id,$3,$3 from memberships m
       where m.account_id=$1 and m.role='owner' and m.status='active'
         and not exists(select 1 from seat_reservations r
           where r.account_id=$1 and r.membership_id=m.id and r.state='active')`,
      [accountId, sourceA, now],
    );
  });
}

async function seedOwnerSeat(owner: Database): Promise<void> {
  await owner.pool.query(
    `insert into seat_reservations
      (account_id,slot,source_registry_id,state,membership_id,created_at,updated_at)
     select $1,1,$2,'active',$3,$4,$4
     where not exists(select 1 from seat_reservations
       where account_id=$1 and membership_id=$3 and state='active')`,
    [accountA, sourceA, membershipA, now],
  );
}

async function commandEvidence(
  owner: Database,
  commandId: string,
): Promise<Readonly<{ decisions: number; audits: number; outbox: number }>> {
  const evidence = await owner.pool.query<{
    decisions: number;
    audits: number;
    outbox: number;
  }>(`select
    (select count(*)::int from access_decision_audit where command_id=$1) decisions,
    (select count(*)::int from audit_events where target_id=$1::text) audits,
    (select count(*)::int from outbox_events where event_id=$1) outbox`,
  [commandId]);
  return evidence.rows[0]!;
}

async function waitForAdvisoryKeyWaiters(
  owner: Database,
  key: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await owner.pool.query<{ count: number }>(
      `with target as (select hashtextextended($1,0) key)
       select count(*)::int count from pg_locks l
       join pg_stat_activity a on a.pid=l.pid cross join target t
       where l.locktype='advisory' and not l.granted and l.objsubid=1
         and a.datname=current_database()
         and a.application_name like 'syntholo-task8-%'
         and l.classid::bigint=((t.key>>32)&4294967295)
         and l.objid::bigint=(t.key&4294967295)`,
      [key],
    );
    if ((waiting.rows[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`ADVISORY_BARRIER_TIMEOUT:${key}:${expected}`);
}

async function waitForBlockerWaiters(
  owner: Database,
  blocker: PoolClient,
  expected: number,
): Promise<void> {
  const blockerPid = (await blocker.query<{ pid: number }>(
    "select pg_backend_pid() pid",
  )).rows[0]!.pid;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await owner.pool.query<{ count: number }>(
      `select count(*)::int count from pg_stat_activity a
       where a.datname=current_database()
         and $1=any(pg_blocking_pids(a.pid))`,
      [blockerPid],
    );
    if ((waiting.rows[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`RUNTIME_LOCK_BARRIER_TIMEOUT:${blockerPid}:${expected}`);
}

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return Object.freeze({ promise, resolve });
}

describe.sequential("entitlement authority database", () => {
  let harness: TestDatabaseHarness;
  let member: RuntimeLogin;
  let staff: RuntimeLogin;
  let system: RuntimeLogin;
  let worker: RuntimeLogin;
  let trustedSystem: Awaited<ReturnType<typeof attestSystemDatabase>>;

  const ownerUnitOfWork = (
    correlationId = randomUUID(),
    clockNow = now,
  ) => createUnitOfWork(member.database, {
    accountId: accountA,
    actor: trustedMemberActor({
      kind: "member",
      actorId: identityA,
      accountId: accountA,
      clerkUserId: `user_${accountA}`,
      membershipId: membershipA,
      role: "owner",
      authenticatedAt: now,
    }),
    correlationId,
    clock: { now: () => clockNow },
  });

  const systemUnitOfWork = (
    accountId = accountA,
    correlationId = randomUUID(),
    clockNow = now,
  ) => createSystemUnitOfWork(
    trustedSystem,
    {
      accountId,
      actor: { kind: "system", actorId: "commerce-webhook" },
      correlationId,
      clock: { now: () => clockNow },
    },
  );

  const staffUnitOfWork = (
    accountId = accountA,
    correlationId = randomUUID(),
    clockNow = now,
    actor: StaffActor = trustedStaffActor({
      kind: "staff", actorId: "30000000-0000-4000-8000-000000000001",
      workosUserId: "workos-admin", staffId: "30000000-0000-4000-8000-000000000001",
      role: "admin", permissions: Object.freeze(["entitlements:manage"]),
      authenticatedAt: now,
    }),
  ) => createUnitOfWork(staff.database, {
    accountId, actor, correlationId, clock: { now: () => clockNow },
  });

  const seedAccount = async (accountId: string, withOwner = true): Promise<void> => {
    await seedUnclaimedAccount(harness.database, accountId);
    if (!withOwner) return;
    const claim = applied(await systemUnitOfWork(accountId).transaction((tx) =>
      tx.entitlements.establishOwner({
        commandId: randomUUID(),
        clerkUserId: `user_${accountId}`,
        email: `owner-${accountId}@example.test`,
      })));
    if (accountId === accountA) {
      membershipA = claim.membershipId;
      const identity = await harness.database.pool.query<{ member_identity_id: string }>(
        "select member_identity_id from memberships where id=$1",
        [membershipA],
      );
      identityA = identity.rows[0]!.member_identity_id;
    }
  };

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (!baseUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
    member = await runtimeLogin(harness.database, baseUrl, "member", "syntholo_member_api");
    staff = await runtimeLogin(harness.database, baseUrl, "staff", "syntholo_staff_api");
    system = await runtimeLogin(harness.database, baseUrl, "system", "syntholo_system_api");
    trustedSystem = await attestSystemDatabase(system.database);
    worker = await runtimeLogin(harness.database, baseUrl, "worker", "syntholo_worker");
  });

  beforeEach(async () => {
    await harness.reset();
    await harness.database.pool.query(
      `insert into staff_identities(id,provider_user_id,role,permissions)
       values('30000000-0000-4000-8000-000000000001','workos-admin','admin',
         array['entitlements:manage'])`,
    );
  });

  afterAll(async () => {
    if (harness) {
      await Promise.allSettled([member, staff, system, worker]
        .filter((login): login is RuntimeLogin => login !== undefined)
        .map((login) => dropLogin(harness.database, login)));
      await harness.close();
    }
  });

  it("adds migration 0005 after the exact accepted 0004 journal", async () => {
    const journal = await harness.database.pool.query<{
      created_at: string;
      hash: string;
    }>(
      `select hash,created_at::text created_at
       from drizzle.__drizzle_migrations order by id`,
    );
    expect(journal.rowCount).toBe(5);
    expect(journal.rows.slice(-2)).toEqual([
      {
        created_at: "1786640400000",
        hash: "717c39300253771cbd09070c2b75297c0bfd788290c522877bbbf7293c4a7ea1",
      },
      {
        created_at: "1786647600000",
        hash: "b61002f28e9970c63ea24a291ebcca8711bdd1f1a178b9ce09910243cc6683b5",
      },
    ]);
    const tables = await harness.database.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema='public'
       and table_name = any($1::text[]) order by table_name`,
      [[
        "access_decision_audit", "account_hold_sources", "account_holds",
        "administrative_grant_restorations",
        "business_os_subscription_cancellations",
        "business_os_setup_receipts", "commerce_fulfillment_receipts",
        "club_subscription_cancellations", "commerce_reconciliations",
        "entitlement_commands", "entitlement_grants", "entitlement_sources",
        "seat_invitation_token_generations", "seat_invitations", "seat_reservations",
      ]],
    );
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "access_decision_audit", "account_hold_sources", "account_holds",
      "administrative_grant_restorations",
      "business_os_setup_receipts", "business_os_subscription_cancellations",
      "club_subscription_cancellations", "commerce_fulfillment_receipts",
      "commerce_reconciliations",
      "entitlement_commands", "entitlement_grants", "entitlement_sources",
      "seat_invitation_token_generations", "seat_invitations", "seat_reservations",
    ]);
  });

  it("installs the exact unique predicates and deferred triggers used by races", async () => {
    const indexes = await harness.database.pool.query<{
      columns: string;
      index_name: string;
      is_unique: boolean;
      predicate: string;
      table_name: string;
    }>(`select c.relname index_name,t.relname table_name,i.indisunique is_unique,
        array_to_string(array(
          select a.attname from unnest(i.indkey) with ordinality k(attnum,ord)
          join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
          order by k.ord),',') columns,
        coalesce(regexp_replace(pg_get_expr(i.indpred,i.indrelid),
          '[[:space:]]+',' ','g'),'') predicate
      from pg_index i
      join pg_class c on c.oid=i.indexrelid
      join pg_class t on t.oid=i.indrelid
      where c.relname=any($1::text[]) order by c.relname`, [[
      "memberships_one_active_owner_per_account",
      "entitlement_grants_one_structural_academy_purchase_slot",
      "entitlement_grants_one_effective_club_subscription",
      "entitlement_grants_one_effective_business_os_subscription",
      "seat_invitation_tokens_one_live_generation",
      "seat_reservations_occupied_slot_unique",
      "seat_reservations_active_membership_unique",
    ]]);
    expect(indexes.rows).toEqual([
      {
        columns: "account_id",
        index_name: "entitlement_grants_one_effective_business_os_subscription",
        is_unique: true,
        predicate: "((capability = 'business_os'::text) AND (source_kind = 'subscription'::text) AND (offer_code = 'business_os'::text) AND (status = ANY (ARRAY['active'::text, 'grace'::text])))",
        table_name: "entitlement_grants",
      },
      {
        columns: "account_id",
        index_name: "entitlement_grants_one_effective_club_subscription",
        is_unique: true,
        predicate: "((capability = 'operator_club'::text) AND (source_kind = 'subscription'::text) AND (offer_code = ANY (ARRAY['operator_club_monthly'::text, 'operator_club_annual'::text])) AND (status = ANY (ARRAY['active'::text, 'grace'::text])))",
        table_name: "entitlement_grants",
      },
      {
        columns: "account_id",
        index_name: "entitlement_grants_one_structural_academy_purchase_slot",
        is_unique: true,
        predicate: "((capability = 'academy_course'::text) AND (source_kind = 'purchase'::text) AND (offer_code = ANY (ARRAY['self_paced'::text, 'guided_pilot'::text])) AND (status = ANY (ARRAY['active'::text, 'grace'::text])))",
        table_name: "entitlement_grants",
      },
      {
        columns: "account_id",
        index_name: "memberships_one_active_owner_per_account",
        is_unique: true,
        predicate: "((role = 'owner'::text) AND (status = 'active'::text))",
        table_name: "memberships",
      },
      {
        columns: "invitation_id",
        index_name: "seat_invitation_tokens_one_live_generation",
        is_unique: true,
        predicate: "((consumed_at IS NULL) AND (superseded_at IS NULL))",
        table_name: "seat_invitation_token_generations",
      },
      {
        columns: "membership_id",
        index_name: "seat_reservations_active_membership_unique",
        is_unique: true,
        predicate: "(state = 'active'::text)",
        table_name: "seat_reservations",
      },
      {
        columns: "account_id,slot",
        index_name: "seat_reservations_occupied_slot_unique",
        is_unique: true,
        predicate: "(state = ANY (ARRAY['pending'::text, 'active'::text]))",
        table_name: "seat_reservations",
      },
    ]);
    const triggers = await harness.database.pool.query<{
      enabled: string;
      initially_deferred: boolean;
      is_deferrable: boolean;
      table_name: string;
      trigger_name: string;
    }>(`select tgname trigger_name,tgrelid::regclass::text table_name,
        tgdeferrable is_deferrable,tginitdeferred initially_deferred,
        tgenabled enabled
      from pg_trigger where not tgisinternal and tgname=any($1::text[])
      order by tgname`, [[
      "accounts_owner_valid", "memberships_owner_seat_valid",
      "seat_grant_valid", "seat_reservations_valid",
    ]]);
    expect(triggers.rows).toEqual([
      { enabled: "O", initially_deferred: true, is_deferrable: true,
        table_name: "accounts", trigger_name: "accounts_owner_valid" },
      { enabled: "O", initially_deferred: true, is_deferrable: true,
        table_name: "memberships", trigger_name: "memberships_owner_seat_valid" },
      { enabled: "O", initially_deferred: true, is_deferrable: true,
        table_name: "entitlement_grants", trigger_name: "seat_grant_valid" },
      { enabled: "O", initially_deferred: true, is_deferrable: true,
        table_name: "seat_reservations", trigger_name: "seat_reservations_valid" },
    ]);
  });

  it("rejects cross-account, wrong-target, and wrong-kind receipt incident links", async () => {
    await seedAccount(accountA);
    await seedAccount(accountB);
    const insertSource = async (
      client: PoolClient,
      id: string,
      accountId: string,
      sourceId: string,
    ) => client.query(
      `insert into entitlement_sources
        (id,account_id,source_kind,source_id,offer_code,provenance,created_at)
       values($1,$2,'purchase',$3,'business_os','hostile-link-test',$4)`,
      [id, accountId, sourceId, now],
    );
    const insertIncident = async (
      client: PoolClient,
      id: string,
      accountId: string,
      incidentKind: "parked_paid_receipt" | "provider_source_collision",
      target: string | null,
      fingerprint: string,
    ) => client.query(
      `insert into commerce_reconciliations
        (id,account_id,command_kind,source_kind,source_id,request_fingerprint,
         reason_code,incident_kind,target_source_registry_id,status,
         review_due_at,created_at,updated_at)
       values($1,$2,'business_os_setup_paid','purchase',$3,$4,
         'BUSINESS_OS_SETUP_RECONCILIATION_REQUIRED',$5,$6,'open',
         $7::timestamptz+interval '48 hours',$7,$7)`,
      [id, accountId, `provider-${id}`, fingerprint, incidentKind, target, now],
    );

    const crossSource = randomUUID();
    const crossIncident = randomUUID();
    await expect(inTransaction(harness.database.pool, async (client) => {
      await insertSource(client, crossSource, accountA, "cross-account-receipt");
      await insertIncident(client, crossIncident, accountB,
        "provider_source_collision", null, "a".repeat(64));
      await client.query(
        `insert into business_os_setup_receipts
          (source_registry_id,account_id,reconciliation_id,status,created_at,updated_at)
         values($1,$2,$3,'paid_reconciliation',$4,$4)`,
        [crossSource, accountA, crossIncident, now],
      );
    })).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23503");

    const targetSource = randomUUID();
    const wrongSource = randomUUID();
    const wrongTargetIncident = randomUUID();
    await expect(inTransaction(harness.database.pool, async (client) => {
      await insertSource(client, targetSource, accountA, "receipt-target");
      await insertSource(client, wrongSource, accountA, "receipt-wrong-target");
      await insertIncident(client, wrongTargetIncident, accountA,
        "parked_paid_receipt", targetSource, "b".repeat(64));
      await client.query(
        `insert into business_os_setup_receipts
          (source_registry_id,account_id,reconciliation_id,status,created_at,updated_at)
         values($1,$2,$3,'paid_reconciliation',$4,$4)`,
        [wrongSource, accountA, wrongTargetIncident, now],
      );
    })).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23514");

    const wrongKindSource = randomUUID();
    const wrongKindIncident = randomUUID();
    await expect(inTransaction(harness.database.pool, async (client) => {
      await insertSource(client, wrongKindSource, accountA, "receipt-wrong-kind");
      await insertIncident(client, wrongKindIncident, accountA,
        "provider_source_collision", wrongKindSource, "c".repeat(64));
      await client.query(
        `insert into business_os_setup_receipts
          (source_registry_id,account_id,reconciliation_id,status,created_at,updated_at)
         values($1,$2,$3,'paid_reconciliation',$4,$4)`,
        [wrongKindSource, accountA, wrongKindIncident, now],
      );
    })).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23514");
  });

  it("upgrades populated 0004 ownership timestamps to canonical milliseconds", async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (!baseUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
    const maintenanceUrl = new URL(baseUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new Pool({
      application_name: "syntholo-entitlement-upgrade-maintenance",
      connectionString: maintenanceUrl.toString(),
      max: 1,
    });
    const databaseName = `syntholo_entitlement_upgrade_${randomUUID().replaceAll("-", "")}`;
    const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const migrationFolder = await mkdtemp(join(tmpdir(), "syntholo-0004-"));
    let upgrade: Database | undefined;
    try {
      await maintenance.query(`create database ${quoteIdentifier(databaseName)}`);
      await mkdir(join(migrationFolder, "meta"));
      for (const migration of [
        "0001_foundation.sql",
        "0002_roles_and_rls.sql",
        "0003_staff_authentication.sql",
        "0004_audit_and_jobs.sql",
      ]) {
        await writeFile(
          join(migrationFolder, migration),
          await readFile(new URL(`../drizzle/${migration}`, import.meta.url)),
        );
      }
      const journal = JSON.parse(await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      )) as { entries: unknown[] };
      await writeFile(join(migrationFolder, "meta/_journal.json"), JSON.stringify({
        ...journal,
        entries: journal.entries.slice(0, 4),
      }));
      const upgradeUrl = new URL(baseUrl);
      upgradeUrl.pathname = `/${databaseName}`;
      upgrade = createDatabase({
        applicationName: "syntholo-entitlement-upgrade",
        url: upgradeUrl.toString(),
      });
      await migrate(upgrade, { migrationsFolder: migrationFolder });
      const beforeUpgrade = await upgrade.pool.query<{
        created_at: string;
        hash: string;
      }>(`select hash,created_at::text created_at
          from drizzle.__drizzle_migrations order by id`);
      expect(beforeUpgrade.rows).toHaveLength(4);
      expect(beforeUpgrade.rows.at(-1)).toEqual({
        created_at: "1786640400000",
        hash: "717c39300253771cbd09070c2b75297c0bfd788290c522877bbbf7293c4a7ea1",
      });
      await upgrade.pool.query(`
        insert into accounts(id,name,status,created_at,updated_at)
          values('30000000-0000-4000-8000-000000000003','Legacy','active',
            '2026-01-02 03:04:05.123456+00','2026-01-02 03:04:05.123456+00');
        insert into member_identities(id,account_id,provider,provider_user_id,created_at,updated_at)
          values('30000000-0000-4000-8000-000000000013',
            '30000000-0000-4000-8000-000000000003','clerk','legacy-owner',
            '2026-01-02 03:04:05.123456+00','2026-01-02 03:04:05.123456+00');
        insert into memberships(id,account_id,member_identity_id,role,status,created_at,updated_at)
          values('30000000-0000-4000-8000-000000000023',
            '30000000-0000-4000-8000-000000000003',
            '30000000-0000-4000-8000-000000000013','owner','active',
            '2026-01-02 03:04:05.123456+00','2026-01-02 03:04:05.123456+00')
      `);
      await migrateDatabase(upgrade);
      const upgraded = await upgrade.pool.query<{
        journal_count: number;
        owner_established_at: string;
      }>(`
        select
          (select count(*)::int from drizzle.__drizzle_migrations) journal_count,
          to_char(owner_established_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') owner_established_at
        from accounts where id='30000000-0000-4000-8000-000000000003'
      `);
      expect(upgraded.rows).toEqual([{
        journal_count: 5,
        owner_established_at: "2026-01-02T03:04:05.123Z",
      }]);
      const afterUpgrade = await upgrade.pool.query<{
        created_at: string;
        hash: string;
      }>(`select hash,created_at::text created_at
          from drizzle.__drizzle_migrations order by id`);
      expect(afterUpgrade.rows.slice(-2)).toEqual([
        {
          created_at: "1786640400000",
          hash: "717c39300253771cbd09070c2b75297c0bfd788290c522877bbbf7293c4a7ea1",
        },
        {
          created_at: "1786647600000",
          hash: "b61002f28e9970c63ea24a291ebcca8711bdd1f1a178b9ce09910243cc6683b5",
        },
      ]);
      await migrateDatabase(upgrade);
      const rerun = await upgrade.pool.query<{
        created_at: string;
        hash: string;
      }>(`select hash,created_at::text created_at
          from drizzle.__drizzle_migrations order by id`);
      expect(rerun.rows).toEqual(afterUpgrade.rows);
    } finally {
      await upgrade?.close().catch(() => undefined);
      await maintenance.query(
        `drop database if exists ${quoteIdentifier(databaseName)} with (force)`,
      ).catch(() => undefined);
      await maintenance.end();
      await rm(migrationFolder, { recursive: true, force: true });
    }
  }, 30_000);

  it("attests the fifth inert system capability and denies cross-capability use", async () => {
    await expect(import("./client.js").then(({ assertDatabaseCapability }) =>
      assertDatabaseCapability(system.database, "syntholo_system_api"),
    )).resolves.toBeUndefined();
    await expect(import("./client.js").then(({ assertDatabaseCapability }) =>
      assertDatabaseCapability(member.database, "syntholo_system_api"),
    )).rejects.toThrow("DATABASE_CAPABILITY_INVALID");
    const topology = await harness.database.pool.query(
      `select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,
              rolreplication,rolbypassrls,rolconfig,
              (select rolpassword is null from pg_authid
               where rolname='syntholo_system_api') password_is_null,
              not exists(select 1 from pg_class c
                where c.relowner='syntholo_system_api'::regrole)
              and not exists(select 1 from pg_proc p
                where p.proowner='syntholo_system_api'::regrole)
              and not exists(select 1 from pg_namespace n
                where n.nspowner='syntholo_system_api'::regrole)
              and not exists(select 1 from pg_database d
                where d.datdba='syntholo_system_api'::regrole) owns_nothing
       from pg_roles where rolname='syntholo_system_api'`,
    );
    expect(topology.rows).toEqual([{
      rolname: "syntholo_system_api", rolcanlogin: false, rolsuper: false,
      rolcreatedb: false, rolcreaterole: false, rolreplication: false,
      rolbypassrls: false, rolconfig: null, password_is_null: true,
      owns_nothing: true,
    }]);
    const ddl = await harness.database.pool.query<{
      capability_create: boolean; capability_temp: boolean;
      login_create: boolean; login_temp: boolean;
    }>(`select
      has_database_privilege('syntholo_system_api',current_database(),'CREATE') capability_create,
      has_database_privilege('syntholo_system_api',current_database(),'TEMP') capability_temp,
      has_database_privilege($1,current_database(),'CREATE') login_create,
      has_database_privilege($1,current_database(),'TEMP') login_temp`, [system.roleName]);
    expect(ddl.rows[0]).toEqual({
      capability_create: false, capability_temp: false,
      login_create: false, login_temp: false,
    });
    await expect(system.database.pool.query(
      "create temporary table syntholo_forbidden_system_temp(id integer)",
    )).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses to brand a system login or capability with ownership or extra ACL", async () => {
    const assertBrandRejected = async (): Promise<void> => {
      await expect(attestSystemDatabase(system.database))
        .rejects.toThrow("DATABASE_CAPABILITY_INVALID");
    };
    await harness.database.pool.query(
      "create table syntholo_task8_system_capability_owned(id integer)",
    );
    try {
      await harness.database.pool.query(
        "alter table syntholo_task8_system_capability_owned owner to syntholo_system_api",
      );
      await assertBrandRejected();
    } finally {
      await harness.database.pool.query(
        "drop table syntholo_task8_system_capability_owned",
      );
    }

    await harness.database.pool.query(
      "create table syntholo_task8_system_login_owned(id integer)",
    );
    try {
      await harness.database.pool.query(await formatSql(
        harness.database.pool,
        "alter table syntholo_task8_system_login_owned owner to %I",
        [system.roleName],
      ));
      await assertBrandRejected();
    } finally {
      await harness.database.pool.query(
        "drop table syntholo_task8_system_login_owned",
      );
    }

    await harness.database.pool.query(
      "grant select on staff_sessions to syntholo_system_api",
    );
    try {
      await assertBrandRejected();
    } finally {
      await harness.database.pool.query(
        "revoke select on staff_sessions from syntholo_system_api",
      );
    }
    await harness.database.pool.query(
      "grant select(staff_identity_id) on staff_sessions to syntholo_system_api",
    );
    try {
      expect((await harness.database.pool.query<{
        table_access: boolean; column_access: boolean;
      }>(`select
          has_table_privilege('syntholo_system_api','staff_sessions','select') table_access,
          has_any_column_privilege('syntholo_system_api','staff_sessions','select') column_access`,
      )).rows[0]).toEqual({ table_access: false, column_access: true });
      await assertBrandRejected();
    } finally {
      await harness.database.pool.query(
        "revoke all privileges (staff_identity_id) on staff_sessions from syntholo_system_api",
      );
    }
    await seedAccount(accountA);
    await harness.database.pool.query(
      "grant select(staff_identity_id) on staff_sessions to syntholo_system_api",
    );
    try {
      await expect(systemUnitOfWork().transaction((tx) =>
        tx.entitlements.lockAccount(accountA)))
        .rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "42501");
    } finally {
      await harness.database.pool.query(
        "revoke all privileges (staff_identity_id) on staff_sessions from syntholo_system_api",
      );
    }
    await harness.database.pool.query(await formatSql(
      harness.database.pool,
      "grant select on staff_login_attempts to %I",
      [system.roleName],
    ));
    try {
      await assertBrandRejected();
    } finally {
      await harness.database.pool.query(await formatSql(
        harness.database.pool,
        "revoke select on staff_login_attempts from %I",
        [system.roleName],
      ));
    }
    await harness.database.pool.query(
      "grant execute on function staff_acquire_refresh(bytea,integer,text,integer) to syntholo_system_api",
    );
    try {
      await assertBrandRejected();
      await expect(systemUnitOfWork().transaction((tx) =>
        tx.entitlements.lockAccount(accountA)))
        .rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "42501");
    } finally {
      await harness.database.pool.query(
        "revoke execute on function staff_acquire_refresh(bytea,integer,text,integer) from syntholo_system_api",
      );
    }
    await harness.database.pool.query(`
      create schema syntholo_task8_forbidden_schema;
      revoke all on schema syntholo_task8_forbidden_schema from public;
      create table syntholo_task8_forbidden_schema.secret(id integer);
      create function syntholo_task8_forbidden_schema.mutate_secret()
        returns void language sql
        as $fn$ insert into syntholo_task8_forbidden_schema.secret values(1) $fn$;
      revoke all on function syntholo_task8_forbidden_schema.mutate_secret()
        from public;
      grant usage,create on schema syntholo_task8_forbidden_schema
        to syntholo_system_api;
      grant select on syntholo_task8_forbidden_schema.secret
        to syntholo_system_api;
      grant execute on function syntholo_task8_forbidden_schema.mutate_secret()
        to syntholo_system_api
    `);
    try {
      await assertBrandRejected();
      await expect(systemUnitOfWork().transaction((tx) =>
        tx.entitlements.lockAccount(accountA)))
        .rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "42501");
    } finally {
      await harness.database.pool.query(
        "drop schema syntholo_task8_forbidden_schema cascade",
      );
    }
    await expect(attestSystemDatabase(system.database)).resolves.toBe(system.database);
  });

  it("keeps member reads scoped and denies broad system and worker entitlement reads", async () => {
    const privileges = await harness.database.pool.query<{
      member_grants: boolean;
      member_sources: boolean;
      system_accounts: boolean;
      system_grants: boolean;
      worker_grants: boolean;
      worker_holds: boolean;
      worker_seats: boolean;
    }>(`select
      has_table_privilege('syntholo_member_api','entitlement_grants','select') member_grants,
      has_table_privilege('syntholo_member_api','entitlement_sources','select') member_sources,
      has_table_privilege('syntholo_system_api','accounts','select') system_accounts,
      has_table_privilege('syntholo_system_api','entitlement_grants','select') system_grants,
      has_table_privilege('syntholo_worker','entitlement_grants','select') worker_grants,
      has_table_privilege('syntholo_worker','account_holds','select') worker_holds,
      has_table_privilege('syntholo_worker','seat_reservations','select') worker_seats`);
    expect(privileges.rows[0]).toEqual({
      member_grants: true,
      member_sources: false,
      system_accounts: false,
      system_grants: false,
      worker_grants: false,
      worker_holds: false,
      worker_seats: false,
    });
    await expect(worker.database.pool.query("select id from entitlement_grants"))
      .rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "42501");
    await expect(system.database.pool.query("select id from accounts"))
      .rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "42501");
  });

  it("enforces globally owned immutable sources and same-account grant ownership", async () => {
    await seedAccount(accountA);
    await seedAccount(accountB);
    await seedAcademyBundle(harness.database);
    await expect(harness.database.pool.query(
      `insert into entitlement_sources
       (account_id,source_kind,source_id,offer_code,provenance,created_at)
       values ($1,'purchase','purchase-academy','self_paced','test',$2)`,
      [accountB, now],
    )).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23505");
    await expect(harness.database.pool.query(
      `update entitlement_sources set account_id=$1 where id=$2`,
      [accountB, sourceA],
    )).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23514");
    await expect(harness.database.pool.query(
      `insert into entitlement_grants
       (account_id,source_registry_id,source_kind,source_id,offer_code,capability,
        status,starts_at,provenance,created_at,updated_at)
       values ($1,$2,'purchase','purchase-academy','self_paced','academy_course',
        'active',$3,'test',$3,$3)`,
      [accountB, sourceA, now],
    )).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23503");
  });

  it("rejects incomplete or unequal Academy and Club bundles at commit", async () => {
    await seedAccount(accountA);
    await expect(inTransaction(harness.database.pool, async (client) => {
      await client.query(
        `insert into entitlement_sources
         (id,account_id,source_kind,source_id,offer_code,provenance,created_at)
         values ($1,$2,'purchase','incomplete','self_paced','test',$3)`,
        [sourceA, accountA, now],
      );
      await client.query(
        `insert into entitlement_grants
         (account_id,source_registry_id,source_kind,source_id,offer_code,capability,
          status,starts_at,provenance,created_at,updated_at)
         values ($1,$2,'purchase','incomplete','self_paced','academy_course',
          'active',$3,'test',$3,$3)`,
        [accountA, sourceA, now],
      );
    })).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23514");
  });

  it.each([
    ["Academy Circle null end", "purchase", "self_paced"],
    ["Club operator null end", "subscription", "operator_club_monthly"],
  ] as const)("rejects a complete %s bundle with one NULL end", async (
    _label, sourceKind, offerCode,
  ) => {
    await seedAccount(accountA);
    const productSource = randomUUID();
    const academyParent = sourceKind === "subscription" ? sourceA : null;
    if (academyParent !== null) await seedAcademyBundle(harness.database);
    await expect(inTransaction(harness.database.pool, async (client) => {
      await client.query(
        `insert into entitlement_sources
         (id,account_id,source_kind,source_id,offer_code,academy_source_registry_id,
          provenance,created_at)
         values ($1,$2,$3,$4,$5,$6,'test',$7)`,
        [productSource, accountA, sourceKind, `${sourceKind}-null-end`, offerCode,
          academyParent, now],
      );
      if (sourceKind === "purchase") {
        const startsAt = new Date("2025-08-13T12:00:00.123Z");
        await client.query(
          `insert into entitlement_grants
           (account_id,source_registry_id,source_kind,source_id,offer_code,capability,
            status,starts_at,ends_at,provenance,created_at,updated_at)
           values
           ($1,$2,'purchase','purchase-null-end','self_paced','academy_course','active',$3,null,'test',$3,$3),
           ($1,$2,'purchase','purchase-null-end','self_paced','support','active',$3,$4,'test',$3,$3),
           ($1,$2,'purchase','purchase-null-end','self_paced','circle_write','active',$3,null,'test',$3,$3)`,
          [accountA, productSource, startsAt, now],
        );
      } else {
        const end = new Date(now.getTime() + 86_400_000);
        await client.query(
          `insert into entitlement_grants
           (account_id,source_registry_id,source_kind,source_id,offer_code,capability,
            status,starts_at,ends_at,provenance,created_at,updated_at)
           values
           ($1,$2,'subscription','subscription-null-end','operator_club_monthly','support','active',$3,$4,'test',$3,$3),
           ($1,$2,'subscription','subscription-null-end','operator_club_monthly','circle_write','active',$3,$4,'test',$3,$3),
           ($1,$2,'subscription','subscription-null-end','operator_club_monthly','operator_club','active',$3,null,'test',$3,$3)`,
          [accountA, productSource, now, end],
        );
      }
    })).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23514");
  });

  it("rejects a second nonterminal Club bundle at the database boundary", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const end = new Date(now.getTime() + 86_400_000);
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        academySourceRegistryId: sourceA, offerCode: "operator_club_monthly",
        sourceId: "club-unique-first", sourceKind: "subscription",
        startsAt: now, endsAt: end })));
    const duplicateSource = randomUUID();
    await expect(inTransaction(harness.database.pool, async (client) => {
      await client.query(`insert into entitlement_sources
        (id,account_id,source_kind,source_id,offer_code,academy_source_registry_id,
         provenance,created_at) values($1,$2,'subscription','club-unique-second',
         'operator_club_annual',$3,'test',$4)`,
      [duplicateSource, accountA, sourceA, now]);
      await client.query(`insert into entitlement_grants
        (account_id,source_registry_id,source_kind,source_id,offer_code,capability,
         status,starts_at,ends_at,provenance,created_at,updated_at)
        select $1,$2,'subscription','club-unique-second','operator_club_annual',
          capability,'active',$3,$4,'test',$3,$3
        from unnest(array['support','circle_write','operator_club']) capability`,
      [accountA, duplicateSource, now, end]);
    })).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23505");
  });

  it("rejects infinite, out-of-range, and reversed stored Task8 instants", async () => {
    await seedAccount(accountA);
    await expect(harness.database.pool.query(
      `insert into entitlement_sources
       (account_id,source_kind,source_id,provenance,created_at)
       values ($1,'administrative','infinite-source','test','infinity')`,
      [accountA],
    )).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23514");
    await seedAcademyBundle(harness.database);
    await expect(harness.database.pool.query(
      `insert into seat_reservations
       (account_id,slot,source_registry_id,state,membership_id,created_at,updated_at)
       values ($1,1,$2,'active',$3,'12000-01-01','1990-01-01')`,
      [accountA, sourceA, membershipA],
    )).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23514");
  });

  it("rejects SQL NULL required inputs before every closed command ledger", async () => {
    const hash = "a".repeat(64);
    const calls: readonly Readonly<{
      commandId: string;
      query: string;
      values: readonly unknown[];
    }>[] = [
      { commandId: randomUUID(), query: `select * from syntholo_establish_owner(
          $1::uuid,$2::uuid,$3::text,null::text,'owner@example.test',$4::timestamptz)`,
        values: [accountA, "", hash, now] },
      { commandId: randomUUID(), query: `select * from syntholo_reserve_pending_seat(
          $1::uuid,$2::uuid,$3::text,$4::uuid,null::text,$5::bytea,$6::timestamptz)`,
        values: [accountA, "", hash, sourceA, Buffer.alloc(32), now] },
      { commandId: randomUUID(), query: `select * from syntholo_resend_invitation(
          $1::uuid,$2::uuid,$3::text,$4::uuid,null::bytea,$5::timestamptz)`,
        values: [accountA, "", hash, randomUUID(), now] },
      { commandId: randomUUID(), query: `select * from syntholo_fulfill_product(
          $1::uuid,$2::uuid,$3::text,null::text,'source','self_paced',null::uuid,
          $4::timestamptz,null::timestamptz,$4::timestamptz)`,
        values: [accountA, "", hash, now] },
      { commandId: randomUUID(), query: `select * from syntholo_redeem_invitation(
          $1::uuid,$2::uuid,$3::text,$4::bytea,'clerk-user',null::text,$5::timestamptz)`,
        values: [accountA, "", hash, Buffer.alloc(32), now] },
      { commandId: randomUUID(), query: `select * from syntholo_expire_invitation(
          $1::uuid,$2::uuid,$3::text,null::uuid,$4::timestamptz)`,
        values: [accountA, "", hash, now] },
      { commandId: randomUUID(), query: `select * from syntholo_revoke_seat(
          $1::uuid,$2::uuid,$3::text,$4::uuid,null::text,$5::timestamptz)`,
        values: [accountA, "", hash, randomUUID(), now] },
      { commandId: randomUUID(), query: `select * from syntholo_replace_seat(
          $1::uuid,$2::uuid,$3::text,$4::uuid,'next@example.test',$5::bytea,
          null::text,$6::timestamptz)`,
        values: [accountA, "", hash, randomUUID(), Buffer.alloc(32), now] },
      { commandId: randomUUID(), query: `select * from syntholo_transfer_ownership(
          $1::uuid,$2::uuid,$3::text,$4::uuid,null::text,$5::timestamptz)`,
        values: [accountA, "", hash, randomUUID(), now] },
      { commandId: randomUUID(), query: `select * from syntholo_refund_product(
          $1::uuid,$2::uuid,$3::text,$4::uuid,null::text,$5::timestamptz)`,
        values: [accountA, "", hash, sourceA, now] },
      { commandId: randomUUID(), query: `select * from syntholo_open_dispute(
          $1::uuid,$2::uuid,$3::text,null::text,$4::uuid,$5::timestamptz)`,
        values: [accountA, "", hash, sourceA, now] },
      { commandId: randomUUID(), query: `select * from syntholo_resolve_dispute(
          $1::uuid,$2::uuid,$3::text,$4::uuid,null::text,$5::timestamptz)`,
        values: [accountA, "", hash, randomUUID(), now] },
      ...[
        "syntholo_club_payment_failed",
        "syntholo_club_payment_recovered",
        "syntholo_club_cancelled",
        "syntholo_business_os_payment_failed",
        "syntholo_business_os_payment_recovered",
        "syntholo_business_os_renewed",
        "syntholo_business_os_cancelled",
      ].map((functionName) => ({ commandId: randomUUID(),
        query: `select * from ${functionName}(
          $1::uuid,$2::uuid,$3::text,null::uuid,$4::timestamptz,$4::timestamptz)`,
        values: [accountA, "", hash, now] })),
      ...[
        "syntholo_expire_club",
        "syntholo_expire_included_support",
        "syntholo_expire_business_os",
      ].map((functionName) => ({ commandId: randomUUID(),
        query: `select * from ${functionName}(
          $1::uuid,$2::uuid,$3::text,null::uuid,$4::timestamptz)`,
        values: [accountA, "", hash, now] })),
    ].map((call) => ({
      ...call,
      values: call.values.map((value) => value === "" ? call.commandId : value),
    }));
    for (const call of calls) {
      const runtime = /syntholo_(reserve_pending_seat|resend_invitation|revoke_seat|replace_seat|transfer_ownership)/u
        .test(call.query) ? member.database : system.database;
      try {
        await runtime.pool.query(call.query, [...call.values]);
        throw new Error("EXPECTED_NULL_INPUT_REJECTION");
      } catch (error) {
        expect(databaseErrorCode(error), call.query).toBe("22023");
      }
    }
    const ledgers = await harness.database.pool.query<{ count: number }>(
      "select count(*)::int count from entitlement_commands where command_id=any($1::uuid[])",
      [calls.map(({ commandId }) => commandId)],
    );
    expect(ledgers.rows[0]?.count).toBe(0);
  });

  it("keeps the established-owner marker one-way and rejects raw establishment", async () => {
    await seedAccount(accountA);
    await expect(inTransaction(harness.database.pool, async (client) => {
      await client.query("update accounts set owner_established_at=null where id=$1", [accountA]);
      await client.query("update memberships set status='revoked' where account_id=$1", [accountA]);
    })).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23514");
    await seedAccount(accountB, false);
    await expect(harness.database.pool.query(
      "update accounts set owner_established_at=$2 where id=$1",
      [accountB, now],
    )).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23514");
  });

  it("serializes four teammate invitations behind the occupied owner slot", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const accountLockKey = `syntholo-entitlement-account:${accountA}`;
    const blocker = await harness.database.pool.connect();
    await blocker.query(
      "select pg_advisory_lock(hashtextextended($1,0))",
      [accountLockKey],
    );
    const commandIds = Array.from({ length: 4 }, () => randomUUID());
    const pending = Promise.allSettled(commandIds.map((commandId, index) =>
      ownerUnitOfWork().transaction((tx) => tx.entitlements.reservePendingSeat({
        commandId,
        sourceRegistryId: sourceA,
        email: `teammate${index}@example.test`,
        tokenHash: Buffer.alloc(32, index + 1),
      })),
    ));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 4);
    await blocker.query(
      "select pg_advisory_unlock(hashtextextended($1,0))",
      [accountLockKey],
    );
    blocker.release();
    const results = await pending;
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(4);
    const outcomes = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []);
    expect(outcomes.filter(({ status }) => status === "applied")).toHaveLength(2);
    const denied = outcomes.filter(({ status }) => status === "denied");
    expect(denied).toHaveLength(2);
    for (const outcome of denied) {
      expect(outcome).toMatchObject({
        status: "denied", code: "SEAT_CAPACITY_REACHED",
      });
    }
    for (const [index, outcome] of outcomes.entries()) {
      expect(await commandEvidence(harness.database, commandIds[index]!)).toEqual({
        decisions: 1,
        audits: 1,
        outbox: outcome.status === "applied" ? 1 : 0,
      });
    }
    const count = await harness.database.pool.query<{ count: number }>(
      `select count(*)::int count from seat_reservations where account_id=$1
       and (state='active' or (state='pending' and expires_at>$2))`,
      [accountA, now],
    );
    expect(count.rows[0]?.count).toBe(3);
  });

  it("serializes an unclaimed Academy owner claim with three teammate invitations", async () => {
    await seedAccount(accountA, false);
    await seedAcademyBundle(harness.database);
    const claimReady = deferred();
    const releaseClaim = deferred();
    const claimCommand = randomUUID();
    let claimedOwner!: Readonly<{
      identityId: string;
      membershipId: string;
    }>;
    const claimPending = systemUnitOfWork().transaction(async (tx) => {
      const outcome = await tx.entitlements.establishOwner({
        commandId: claimCommand,
        clerkUserId: "unclaimed-race-owner",
        email: "unclaimed-race-owner@example.test",
      });
      if (outcome.status !== "applied") throw new Error("EXPECTED_OWNER_CLAIM");
      claimedOwner = outcome.value;
      claimReady.resolve();
      await releaseClaim.promise;
      return outcome;
    });
    await claimReady.promise;
    const inviteCommands = Array.from({ length: 3 }, () => randomUUID());
    const invitePending = Promise.all(inviteCommands.map((commandId, index) =>
      createUnitOfWork(member.database, {
        accountId: accountA,
        actor: trustedMemberActor({
          kind: "member",
          actorId: claimedOwner.identityId,
          accountId: accountA,
          clerkUserId: "unclaimed-race-owner",
          membershipId: claimedOwner.membershipId,
          role: "owner",
          authenticatedAt: now,
        }),
        correlationId: randomUUID(),
        clock: { now: () => now },
      }).transaction((tx) => tx.entitlements.reservePendingSeat({
        commandId,
        sourceRegistryId: sourceA,
        email: `unclaimed-race-${index}@example.test`,
        tokenHash: Buffer.alloc(32, 120 + index),
      })),
    ));
    await waitForAdvisoryKeyWaiters(
      harness.database,
      `syntholo-entitlement-account:${accountA}`,
      3,
    );
    releaseClaim.resolve();
    expect((await claimPending).status).toBe("applied");
    const invites = await invitePending;
    expect(invites.filter(({ status }) => status === "applied")).toHaveLength(2);
    expect(invites.filter(({ status }) => status === "denied"))
      .toEqual([expect.objectContaining({ code: "SEAT_CAPACITY_REACHED" })]);
    expect((await harness.database.pool.query<{ occupied: number }>(
      `select count(*)::int occupied from seat_reservations
       where account_id=$1 and state in ('active','pending')`,
      [accountA],
    )).rows[0]?.occupied).toBe(3);
    expect(await commandEvidence(harness.database, claimCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    for (const [index, outcome] of invites.entries()) {
      expect(await commandEvidence(harness.database, inviteCommands[index]!)).toEqual({
        decisions: 1,
        audits: 1,
        outbox: outcome.status === "applied" ? 1 : 0,
      });
    }
  });

  it("serializes Academy refund and invitation in both lock orders", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);

    const refundReady = deferred();
    const releaseRefund = deferred();
    const refundCommand = randomUUID();
    const losingInviteCommand = randomUUID();
    const refundPending = systemUnitOfWork().transaction(async (tx) => {
      const outcome = await tx.entitlements.refundProduct({
        commandId: refundCommand,
        sourceRegistryId: sourceA,
        reason: "Refund won the invitation serialization race",
      });
      refundReady.resolve();
      await releaseRefund.promise;
      return outcome;
    });
    await refundReady.promise;
    const losingInvite = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: losingInviteCommand,
        sourceRegistryId: sourceA,
        email: "refund-first@example.test",
        tokenHash: Buffer.alloc(32, 111),
      }));
    await waitForAdvisoryKeyWaiters(
      harness.database,
      `syntholo-entitlement-account:${accountA}`,
      1,
    );
    releaseRefund.resolve();
    expect((await refundPending).status).toBe("applied");
    expect(await losingInvite).toMatchObject({
      status: "denied",
      code: "ACADEMY_SOURCE_REQUIRED",
    });
    expect(await commandEvidence(harness.database, losingInviteCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });

    const repurchase = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        commandId: randomUUID(),
        offerCode: "self_paced",
        sourceId: "refund-invite-race-repurchase",
        sourceKind: "purchase",
        startsAt: now,
      })));
    const inviteReady = deferred();
    const releaseInvite = deferred();
    const winningInviteCommand = randomUUID();
    const secondRefundCommand = randomUUID();
    const winningInvitePending = ownerUnitOfWork().transaction(async (tx) => {
      const outcome = await tx.entitlements.reservePendingSeat({
        commandId: winningInviteCommand,
        sourceRegistryId: repurchase.sourceRegistryId,
        email: "invite-first@example.test",
        tokenHash: Buffer.alloc(32, 112),
      });
      inviteReady.resolve();
      await releaseInvite.promise;
      return outcome;
    });
    await inviteReady.promise;
    const secondRefundPending = systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: secondRefundCommand,
        sourceRegistryId: repurchase.sourceRegistryId,
        reason: "Refund followed the committed invitation",
      }));
    await waitForAdvisoryKeyWaiters(
      harness.database,
      `syntholo-entitlement-account:${accountA}`,
      1,
    );
    releaseInvite.resolve();
    const winningInvite = applied(await winningInvitePending);
    expect((await secondRefundPending).status).toBe("applied");
    expect((await harness.database.pool.query<{ state: string }>(
      "select state from seat_reservations where id=$1",
      [winningInvite.reservationId],
    )).rows[0]?.state).toBe("revoked");
    expect(await commandEvidence(harness.database, winningInviteCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect(await commandEvidence(harness.database, secondRefundCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
  });

  it("preserves immutable invitation generations and original seven-day expiry", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const invited = applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(), sourceRegistryId: sourceA,
        email: " TEAM@example.test ", tokenHash: Buffer.alloc(32, 1) })));
    const resendAt = new Date(now.getTime() + 86_400_000);
    const resent = applied(await createUnitOfWork(member.database, {
      accountId: accountA,
      actor: {
        kind: "member", actorId: identityA, accountId: accountA,
        clerkUserId: `user_${accountA}`, membershipId: membershipA,
        role: "owner", authenticatedAt: now,
      },
      correlationId: randomUUID(), clock: { now: () => resendAt },
    }).transaction((tx) => tx.entitlements.resendInvitation({
      commandId: randomUUID(), invitationId: invited.invitationId,
      tokenHash: Buffer.alloc(32, 2),
    })));
    expect(resent.expiresAt).toEqual(new Date(now.getTime() + 168 * 3_600_000));
    const rows = await harness.database.pool.query(
      `select generation,consumed_at,superseded_at from seat_invitation_token_generations
       where invitation_id=$1 order by generation`,
      [invited.invitationId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.superseded_at).not.toBeNull();
    await expect(harness.database.pool.query(
      `update seat_invitations set expires_at=expires_at+interval '1 day' where id=$1`,
      [invited.invitationId],
    )).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "55000");
  });

  it("replays one seat reservation across fresh correlations without consuming another slot", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const commandId = "40000000-0000-4000-8000-000000000001";
    const firstCorrelation = "40000000-0000-4000-8000-000000000011";
    const secondCorrelation = "40000000-0000-4000-8000-000000000012";
    const input = {
      commandId,
      sourceRegistryId: sourceA,
      email: "retry@example.test",
      tokenHash: Buffer.alloc(32, 7),
    };
    const first = await ownerUnitOfWork(firstCorrelation).transaction((tx) =>
      tx.entitlements.reservePendingSeat(input));
    const retry = await ownerUnitOfWork(secondCorrelation).transaction((tx) =>
      tx.entitlements.reservePendingSeat(input));
    expect(retry).toEqual({ ...first, replayed: true });
    const evidence = await harness.database.pool.query(`
      select
        (select count(*)::int from seat_reservations where account_id=$1
          and state='pending') pending_seats,
        (select count(*)::int from access_decision_audit where command_id=$2) decisions,
        (select count(*)::int from audit_events
          where payload->>'referenceId'=$2::text) audits,
        (select count(*)::int from outbox_events where event_id=$2) outbox,
        (select first_correlation_id from entitlement_commands where command_id=$2)
          first_correlation_id
    `, [accountA, commandId]);
    expect(evidence.rows[0]).toEqual({
      pending_seats: 1,
      decisions: 1,
      audits: 1,
      outbox: 1,
      first_correlation_id: firstCorrelation,
    });
    await expect(ownerUnitOfWork(randomUUID()).transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        ...input,
        email: "different@example.test",
      }))).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23505");
  });

  it("refuses member command replay after account suspension", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const commandId = randomUUID();
    const input = {
      commandId,
      sourceRegistryId: sourceA,
      email: "suspended@example.test",
      tokenHash: Buffer.alloc(32, 19),
    };
    await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat(input));
    await harness.database.pool.query(
      "update accounts set status='suspended',updated_at=$2 where id=$1",
      [accountA, new Date(now.getTime() + 1)],
    );
    await expect(ownerUnitOfWork(randomUUID(), new Date(now.getTime() + 2))
      .transaction((tx) => tx.entitlements.reservePendingSeat(input)))
      .rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "42501");
    const count = await harness.database.pool.query<{ count: number }>(
      "select count(*)::int count from seat_reservations where account_id=$1",
      [accountA],
    );
    expect(count.rows[0]?.count).toBe(2);
  });

  it("commits denied evidence without lifecycle mutation or outbox", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const staleStart = new Date(now.getTime() - 169 * 3_600_000);
    const staleInvite = applied(await ownerUnitOfWork(randomUUID(), staleStart)
      .transaction((tx) => tx.entitlements.reservePendingSeat({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        email: "stale@example.test", tokenHash: Buffer.alloc(32, 20),
      })));
    const before = await harness.database.pool.query(
      "select state,updated_at from seat_reservations where id=$1",
      [staleInvite.reservationId],
    );
    const commandId = "40000000-0000-4000-8000-000000000004";
    const denied = await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId,
        sourceRegistryId: "40000000-0000-4000-8000-000000000099",
        email: "denied@example.test",
        tokenHash: Buffer.alloc(32, 21),
      }));
    expect(denied).toEqual({
      status: "denied",
      code: "ACADEMY_SOURCE_REQUIRED",
      replayed: false,
    });
    const after = await harness.database.pool.query(
      "select state,updated_at from seat_reservations where id=$1",
      [staleInvite.reservationId],
    );
    expect(after.rows).toEqual(before.rows);
    const evidence = await harness.database.pool.query(`select
      (select count(*)::int from access_decision_audit where command_id=$1) decisions,
      (select count(*)::int from audit_events where target_id=$1::text) audits,
      (select count(*)::int from outbox_events where event_id=$1) outbox`,
    [commandId]);
    expect(evidence.rows[0]).toEqual({ decisions: 1, audits: 1, outbox: 0 });
  });

  it("replays owner claim and invitation resend without duplicate history", async () => {
    await seedAccount(accountA, false);
    await seedAcademyBundle(harness.database);
    const claimCommand = "40000000-0000-4000-8000-000000000002";
    const claimInput = {
      commandId: claimCommand,
      clerkUserId: "idempotent-owner",
      email: "owner@example.test",
    };
    const firstClaim = await systemUnitOfWork(
      accountA,
      "40000000-0000-4000-8000-000000000013",
    ).transaction((tx) => tx.entitlements.establishOwner(claimInput));
    const replayClaim = await systemUnitOfWork(
      accountA,
      "40000000-0000-4000-8000-000000000014",
    ).transaction((tx) => tx.entitlements.establishOwner(claimInput));
    expect(replayClaim).toEqual({ ...firstClaim, replayed: true });
    membershipA = applied(firstClaim).membershipId;
    identityA = (await harness.database.pool.query<{ member_identity_id: string }>(
      "select member_identity_id from memberships where id=$1",
      [membershipA],
    )).rows[0]!.member_identity_id;

    const invited = applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        email: "team@example.test", tokenHash: Buffer.alloc(32, 8),
      })));
    const resendCommand = "40000000-0000-4000-8000-000000000003";
    const resendInput = {
      commandId: resendCommand,
      invitationId: invited.invitationId,
      tokenHash: Buffer.alloc(32, 9),
    };
    const firstResend = await ownerUnitOfWork(
      "40000000-0000-4000-8000-000000000015",
      new Date(now.getTime() + 3_600_000),
    ).transaction((tx) => tx.entitlements.resendInvitation(resendInput));
    const replayResend = await ownerUnitOfWork(
      "40000000-0000-4000-8000-000000000016",
      new Date(now.getTime() + 7_200_000),
    ).transaction((tx) => tx.entitlements.resendInvitation(resendInput));
    expect(replayResend).toEqual({ ...firstResend, replayed: true });
    const generations = await harness.database.pool.query<{ count: number }>(
      `select count(*)::int count from seat_invitation_token_generations
       where invitation_id=$1`,
      [invited.invitationId],
    );
    expect(generations.rows[0]?.count).toBe(2);
  });

  it("replays typed owner-claim denial without dereferencing applied resources", async () => {
    await seedAccount(accountA);
    const commandId = randomUUID();
    const input = {
      commandId,
      clerkUserId: "second-owner-denied",
      email: "second-owner-denied@example.test",
    };
    const first = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.establishOwner(input));
    const replay = await systemUnitOfWork(accountA, randomUUID(),
      new Date(now.getTime() + 1)).transaction((tx) =>
      tx.entitlements.establishOwner(input));
    expect(first).toEqual({ status: "denied", code: "OWNER_EXISTS", replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await commandEvidence(harness.database, commandId))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
  });

  it("does not replay an owner claim after its membership is revoked", async () => {
    await seedAccount(accountA, false);
    const academy = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "self_paced", sourceId: "academy-owner-replay-revoked",
        sourceKind: "purchase", startsAt: now })));
    const claimId = randomUUID();
    const claimInput = { commandId: claimId, clerkUserId: "revoked-original-owner",
      email: "revoked-original-owner@example.test" };
    const claim = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.establishOwner(claimInput)));
    membershipA = claim.membershipId;
    identityA = (await harness.database.pool.query<{ member_identity_id: string }>(
      "select member_identity_id from memberships where id=$1", [membershipA],
    )).rows[0]!.member_identity_id;
    const token = Buffer.alloc(32, 101);
    applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: academy.sourceRegistryId,
        email: "successor@example.test", tokenHash: token })));
    const successor = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.redeemInvitation({ commandId: randomUUID(), tokenHash: token,
        clerkUserId: "successor-owner", email: "successor@example.test" })));
    applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.transferOwnership({ commandId: randomUUID(),
        targetMembershipId: successor.membershipId,
        reason: "Successor appointed before original owner departure" })));
    const successorOwner = createUnitOfWork(member.database, {
      accountId: accountA,
      actor: trustedMemberActor({ kind: "member", actorId: successor.identityId,
        accountId: accountA, clerkUserId: "successor-owner",
        membershipId: successor.membershipId, role: "owner", authenticatedAt: now }),
      correlationId: randomUUID(), clock: { now: () => now },
    });
    const formerSeat = (await harness.database.pool.query<{ id: string }>(
      `select id from seat_reservations
       where account_id=$1 and membership_id=$2 and state='active'`,
      [accountA, membershipA],
    )).rows[0]!.id;
    applied(await successorOwner.transaction((tx) => tx.entitlements.revokeSeat({
      commandId: randomUUID(), reservationId: formerSeat,
      reason: "Original owner departed after ownership transfer" })));
    await expect(systemUnitOfWork(accountA, randomUUID(), new Date(now.getTime() + 1))
      .transaction((tx) => tx.entitlements.establishOwner(claimInput)))
      .rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "42501");
    expect(await commandEvidence(harness.database, claimId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
  });

  it("serializes redemption of superseded and live token generations", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const oldToken = Buffer.alloc(32, 91);
    const liveToken = Buffer.alloc(32, 92);
    const invitation = applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: sourceA, email: "generation-race@example.test",
        tokenHash: oldToken })));
    applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.resendInvitation({ commandId: randomUUID(),
        invitationId: invitation.invitationId, tokenHash: liveToken })));
    const blocker = await harness.database.pool.connect();
    const accountLockKey = `syntholo-entitlement-account:${accountA}`;
    await blocker.query(
      "select pg_advisory_lock(hashtextextended($1,0))",
      [accountLockKey],
    );
    const oldCommand = randomUUID();
    const liveCommand = randomUUID();
    const oldPending = systemUnitOfWork().transaction((tx) =>
      tx.entitlements.redeemInvitation({ commandId: oldCommand,
        tokenHash: oldToken, clerkUserId: "generation-race-old",
        email: "generation-race@example.test" }));
    const livePending = systemUnitOfWork().transaction((tx) =>
      tx.entitlements.redeemInvitation({ commandId: liveCommand,
        tokenHash: liveToken, clerkUserId: "generation-race-live",
        email: "generation-race@example.test" }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 2);
    await blocker.query(
      "select pg_advisory_unlock(hashtextextended($1,0))",
      [accountLockKey],
    );
    blocker.release();
    const [oldResult, liveResult] = await Promise.all([oldPending, livePending]);
    expect(oldResult).toMatchObject({ status: "denied", code: "INVITATION_INACTIVE" });
    expect(liveResult.status).toBe("applied");
    const oldReplay = await systemUnitOfWork(accountA, randomUUID(),
      new Date(now.getTime() + 1)).transaction((tx) =>
      tx.entitlements.redeemInvitation({ commandId: oldCommand,
        tokenHash: oldToken, clerkUserId: "generation-race-old",
        email: "generation-race@example.test" }));
    expect(oldReplay).toEqual({ ...oldResult, replayed: true });
    expect(await commandEvidence(harness.database, oldCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    expect(await commandEvidence(harness.database, liveCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    const generations = await harness.database.pool.query<{
      consumed: boolean; generation: number; superseded: boolean;
    }>(`select generation,consumed_at is not null consumed,
        superseded_at is not null superseded
        from seat_invitation_token_generations where invitation_id=$1
        order by generation`, [invitation.invitationId]);
    expect(generations.rows).toEqual([
      { generation: 1, consumed: false, superseded: true },
      { generation: 2, consumed: true, superseded: false },
    ]);
  });

  it("serializes expiration and reinvitation in both lock orders", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const oldStart = new Date(now.getTime() - 169 * 3_600_000);
    const first = applied(await ownerUnitOfWork(randomUUID(), oldStart)
      .transaction((tx) => tx.entitlements.reservePendingSeat({
        commandId: randomUUID(),
        sourceRegistryId: sourceA,
        email: "expiry-reinvite-race@example.test",
        tokenHash: Buffer.alloc(32, 131),
      })));
    const firstExpireCommand = randomUUID();
    const firstReinviteCommand = randomUUID();
    const accountLockKey = `syntholo-entitlement-account:${accountA}`;
    const firstBlocker = await harness.database.pool.connect();
    await firstBlocker.query(
      "select pg_advisory_lock(hashtextextended($1,0))",
      [accountLockKey],
    );
    const firstExpire = systemUnitOfWork().transaction((tx) =>
      tx.entitlements.expireInvitation({
        commandId: firstExpireCommand,
        invitationId: first.invitationId,
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 1);
    const secondPending = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: firstReinviteCommand,
        sourceRegistryId: sourceA,
        email: "expiry-reinvite-race@example.test",
        tokenHash: Buffer.alloc(32, 132),
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 2);
    await firstBlocker.query(
      "select pg_advisory_unlock(hashtextextended($1,0))",
      [accountLockKey],
    );
    firstBlocker.release();
    expect((await firstExpire).status).toBe("applied");
    const second = applied(await secondPending);

    const later = new Date(now.getTime() + 169 * 3_600_000);
    const secondReinviteCommand = randomUUID();
    const secondExpireCommand = randomUUID();
    const secondBlocker = await harness.database.pool.connect();
    await secondBlocker.query(
      "select pg_advisory_lock(hashtextextended($1,0))",
      [accountLockKey],
    );
    const thirdPending = ownerUnitOfWork(randomUUID(), later).transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: secondReinviteCommand,
        sourceRegistryId: sourceA,
        email: "expiry-reinvite-race@example.test",
        tokenHash: Buffer.alloc(32, 133),
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 1);
    const secondExpire = systemUnitOfWork(accountA, randomUUID(), later)
      .transaction((tx) => tx.entitlements.expireInvitation({
        commandId: secondExpireCommand,
        invitationId: second.invitationId,
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 2);
    await secondBlocker.query(
      "select pg_advisory_unlock(hashtextextended($1,0))",
      [accountLockKey],
    );
    secondBlocker.release();
    const third = applied(await thirdPending);
    expect(await secondExpire).toMatchObject({
      status: "denied",
      code: "INVITATION_INACTIVE",
    });
    const states = await harness.database.pool.query<{
      id: string;
      state: string;
    }>(`select invitation_id id,state from seat_reservations
        where invitation_id=any($1::uuid[])`,
    [[first.invitationId, second.invitationId, third.invitationId]]);
    expect(Object.fromEntries(states.rows.map(({ id, state }) => [id, state])))
      .toEqual({
        [first.invitationId]: "expired",
        [second.invitationId]: "expired",
        [third.invitationId]: "pending",
      });
    expect((await harness.database.pool.query<{ count: number }>(
      `select count(*)::int count from seat_invitation_token_generations t
       join seat_reservations r on r.invitation_id=t.invitation_id
         and r.account_id=t.account_id
       where r.account_id=$1 and r.state='pending'
         and t.consumed_at is null and t.superseded_at is null
         and t.expires_at>$2`, [accountA, later])).rows[0]?.count).toBe(1);
    for (const [commandId, outbox] of [
      [firstExpireCommand, 1], [firstReinviteCommand, 1],
      [secondReinviteCommand, 1], [secondExpireCommand, 0],
    ] as const) {
      expect(await commandEvidence(harness.database, commandId))
        .toEqual({ decisions: 1, audits: 1, outbox });
    }
  });

  it("serializes pending revocation and reinvitation in both lock orders", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const first = applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: randomUUID(),
        sourceRegistryId: sourceA,
        email: "revoke-reinvite-race@example.test",
        tokenHash: Buffer.alloc(32, 134),
      })));
    const accountLockKey = `syntholo-entitlement-account:${accountA}`;
    const firstRevokeCommand = randomUUID();
    const firstReinviteCommand = randomUUID();
    const firstBlocker = await harness.database.pool.connect();
    await firstBlocker.query(
      "select pg_advisory_lock(hashtextextended($1,0))",
      [accountLockKey],
    );
    const firstRevoke = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.revokeSeat({
        commandId: firstRevokeCommand,
        reservationId: first.reservationId,
        reason: "Pending invitation revoked before reinvitation",
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 1);
    const secondPending = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: firstReinviteCommand,
        sourceRegistryId: sourceA,
        email: "revoke-reinvite-race@example.test",
        tokenHash: Buffer.alloc(32, 135),
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 2);
    await firstBlocker.query(
      "select pg_advisory_unlock(hashtextextended($1,0))",
      [accountLockKey],
    );
    firstBlocker.release();
    expect((await firstRevoke).status).toBe("applied");
    const second = applied(await secondPending);

    const secondReinviteCommand = randomUUID();
    const secondRevokeCommand = randomUUID();
    const secondBlocker = await harness.database.pool.connect();
    await secondBlocker.query(
      "select pg_advisory_lock(hashtextextended($1,0))",
      [accountLockKey],
    );
    const thirdPending = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: secondReinviteCommand,
        sourceRegistryId: sourceA,
        email: "revoke-reinvite-race@example.test",
        tokenHash: Buffer.alloc(32, 136),
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 1);
    const secondRevoke = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.revokeSeat({
        commandId: secondRevokeCommand,
        reservationId: second.reservationId,
        reason: "Pending invitation revoked after replacement reserved",
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 2);
    await secondBlocker.query(
      "select pg_advisory_unlock(hashtextextended($1,0))",
      [accountLockKey],
    );
    secondBlocker.release();
    const third = applied(await thirdPending);
    expect((await secondRevoke).status).toBe("applied");
    const states = await harness.database.pool.query<{ id: string; state: string }>(
      `select id,state from seat_reservations where id=any($1::uuid[])`,
      [[first.reservationId, second.reservationId, third.reservationId]],
    );
    expect(Object.fromEntries(states.rows.map(({ id, state }) => [id, state])))
      .toEqual({
        [first.reservationId]: "revoked",
        [second.reservationId]: "revoked",
        [third.reservationId]: "pending",
      });
    expect((await harness.database.pool.query<{ count: number }>(
      `select count(*)::int count from seat_invitation_token_generations t
       join seat_reservations r on r.invitation_id=t.invitation_id
         and r.account_id=t.account_id
       where r.account_id=$1 and r.state='pending'
         and t.consumed_at is null and t.superseded_at is null
         and t.expires_at>$2`, [accountA, now])).rows[0]?.count).toBe(1);
    for (const commandId of [firstRevokeCommand, firstReinviteCommand,
      secondReinviteCommand, secondRevokeCommand]) {
      expect(await commandEvidence(harness.database, commandId))
        .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    }
  });

  it("creates Business-OS-only owner claims with zero Academy seats", async () => {
    await seedAccount(accountA, false);
    const claim = applied(await systemUnitOfWork().transaction((tx) => tx.entitlements.establishOwner({
      commandId: randomUUID(),
      clerkUserId: "business_os_owner",
      email: "owner@example.test",
    })));
    expect(claim.seatActivated).toBe(false);
    const counts = await harness.database.pool.query<{ seats: string; owners: string }>(
      `select
       (select count(*) from seat_reservations)::text seats,
       (select count(*) from memberships where role='owner' and status='active')::text owners`,
    );
    expect(counts.rows[0]).toEqual({ seats: "0", owners: "1" });
  });

  it("does not create Business OS access from the setup-fee purchase", async () => {
    await seedAccount(accountA);
    const setupCommand = randomUUID();
    const setupInput = { commandId: setupCommand,
      sourceId: "business-os-setup-fee", purchasedAt: now };
    const setup = recordedSetup(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recordBusinessOsSetupPurchase(setupInput)));
    const setupReplay = await systemUnitOfWork(accountA, randomUUID())
      .transaction((tx) => tx.entitlements.recordBusinessOsSetupPurchase(setupInput));
    expect(setupReplay).toEqual({ status: "applied", replayed: true, value: setup });
    expect(await commandEvidence(harness.database, setupCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect((await harness.database.pool.query<{ type: string }>(
      "select type from outbox_events where event_id=$1", [setupCommand],
    )).rows[0]?.type).toBe("entitlements.command_applied.v1");
    expect((await harness.database.pool.query<{ sources: number; grants: number }>(
      `select (select count(*)::int from entitlement_sources
          where source_kind='purchase' and source_id='business-os-setup-fee') sources,
        (select count(*)::int from entitlement_grants
          where capability='business_os') grants`,
    )).rows[0]).toEqual({ sources: 1, grants: 0 });
    const activeEnd = new Date(now.getTime() + 86_400_000);
    const subscription = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "business_os", sourceId: "business-os-recurring",
        sourceKind: "subscription", startsAt: now, endsAt: activeEnd })));
    expect((await harness.database.pool.query<{
      source_kind: string; ends_at: Date;
    }>(`select source_kind,ends_at from entitlement_grants
        where source_registry_id=$1`, [subscription.sourceRegistryId])).rows)
      .toEqual([{ source_kind: "subscription", ends_at: activeEnd }]);
    expect((await harness.database.pool.query<{ type: string }>(
      `select type from outbox_events where payload->>'sourceRegistryId'=$1`,
      [subscription.sourceRegistryId],
    )).rows[0]?.type).toBe("entitlements.command_applied.v1");
  });

  it("refunds and disputes Business OS setup receipts without changing access grants", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const first = recordedSetup(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recordBusinessOsSetupPurchase({ commandId: randomUUID(),
        sourceId: "business-os-setup-refund", purchasedAt: now })));
    const refunded = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({ commandId: randomUUID(),
        sourceRegistryId: first.sourceRegistryId,
        reason: "Setup engagement cancelled within policy" })));
    expect(refunded.sourceRegistryId).toBe(first.sourceRegistryId);

    const second = recordedSetup(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recordBusinessOsSetupPurchase({ commandId: randomUUID(),
        sourceId: "business-os-setup-dispute", purchasedAt: now })));
    const disputed = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({ commandId: randomUUID(),
        disputeId: "dp_business_os_setup", targetSourceRegistryId: second.sourceRegistryId })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({ commandId: randomUUID(),
        holdSourceRegistryId: disputed.holdSourceRegistryId, resolution: "lost" })));

    const state = await harness.database.pool.query<{
      source_registry_id: string; status: string;
    }>(`select source_registry_id,status from business_os_setup_receipts
        order by source_registry_id`);
    expect(state.rows).toEqual([
      { source_registry_id: first.sourceRegistryId, status: "refunded" },
      { source_registry_id: second.sourceRegistryId, status: "dispute_lost" },
    ].sort((left, right) => left.source_registry_id.localeCompare(right.source_registry_id)));
    const grants = await harness.database.pool.query<{
      capability: string; status: string;
    }>(`select capability,status from entitlement_grants order by capability`);
    expect(grants.rows).toEqual([
      { capability: "academy_course", status: "active" },
      { capability: "circle_write", status: "active" },
      { capability: "support", status: "active" },
    ]);
    expect((await harness.database.pool.query<{ open: number }>(
      `select count(*)::int open from account_holds h
       join account_hold_sources s on s.id=h.source_registry_id
       where s.target_source_registry_id=$1 and h.released_at is null`,
      [second.sourceRegistryId],
    )).rows[0]?.open).toBe(0);
  });

  it("parks an Academy refund until its linked Club subscription is dispositioned", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const clubEnd = new Date(now.getTime() + 31 * 86_400_000);
    const club = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA,
        commandId: randomUUID(),
        endsAt: clubEnd,
        offerCode: "operator_club_monthly",
        sourceId: "club-linked-academy-refund",
        sourceKind: "subscription",
        startsAt: now,
      })));

    const refundCommand = randomUUID();
    const pending = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: refundCommand,
        sourceRegistryId: sourceA,
        reason: "Customer requested an Academy refund while Club is active",
      }));
    expect(pending).toMatchObject({
      status: "applied",
      value: {
        refundStatus: "reconciliation",
        reconciliationId: expect.any(String),
        reconciliationStatus: "open",
        sourceRegistryId: sourceA,
      },
    });
    expect(await commandEvidence(harness.database, refundCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect((await harness.database.pool.query<{
      academy_statuses: string[];
      club_statuses: string[];
      occupied_seats: number;
      open_holds: number;
    }>(`select
        (select array_agg(distinct status order by status)
           from entitlement_grants where source_registry_id=$1) academy_statuses,
        (select array_agg(distinct status order by status)
           from entitlement_grants where source_registry_id=$2) club_statuses,
        (select count(*)::int from seat_reservations
           where source_registry_id=$1 and state='active') occupied_seats,
        (select count(*)::int from account_holds h
           join account_hold_sources hs on hs.id=h.source_registry_id
           join commerce_reconciliations r on r.id=hs.source_id::uuid
           where r.command_kind='refund_product' and h.released_at is null) open_holds`,
      [sourceA, club.sourceRegistryId],
    )).rows[0]).toEqual({
      academy_statuses: ["active"],
      club_statuses: ["active"],
      occupied_seats: 1,
      open_holds: 3,
    });

    const incident = await harness.database.pool.query<{ id: string }>(
      `select id from commerce_reconciliations
       where account_id=$1 and command_kind='refund_product'
         and incident_kind='linked_academy_refund'`,
      [accountA],
    );
    const reconciliationId = incident.rows[0]?.id;
    if (reconciliationId === undefined) {
      throw new Error("EXPECTED_LINKED_ACADEMY_REFUND_RECONCILIATION");
    }
    applied(await systemUnitOfWork().transaction((tx) => tx.entitlements.cancelClub({
      commandId: randomUUID(),
      sourceRegistryId: club.sourceRegistryId,
      paidThroughAt: clubEnd,
    })));

    expect((await harness.database.pool.query<{
      academy_statuses: string[];
      club_statuses: string[];
      club_receipt: string;
      incident_status: string;
      resolution_code: string;
      occupied_seats: number;
      open_holds: number;
    }>(`select
        (select array_agg(distinct status order by status)
           from entitlement_grants where source_registry_id=$1) academy_statuses,
        (select array_agg(distinct status order by status)
           from entitlement_grants where source_registry_id=$2) club_statuses,
        (select status from commerce_fulfillment_receipts
           where source_registry_id=$2) club_receipt,
        (select status from commerce_reconciliations where id=$3) incident_status,
        (select resolution_code from commerce_reconciliations where id=$3)
          resolution_code,
        (select count(*)::int from seat_reservations
           where source_registry_id=$1 and state='active') occupied_seats,
        (select count(*)::int from account_holds h
           join account_hold_sources hs on hs.id=h.source_registry_id
           where hs.source_kind='academy_refund_reconciliation'
             and hs.source_id=$3::text and h.released_at is null) open_holds`,
      [sourceA, club.sourceRegistryId, reconciliationId],
    )).rows[0]).toEqual({
      academy_statuses: ["refunded"],
      club_statuses: ["revoked"],
      club_receipt: "cancelled",
      incident_status: "resolved_manual",
      resolution_code: "club_cancelled",
      occupied_seats: 0,
      open_holds: 0,
    });
  });

  it("revokes linked Club on a lost Academy dispute and queues provider cancellation", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const paidThrough = new Date(now.getTime() + 31 * 86_400_000);
    const club = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA,
        commandId: randomUUID(),
        endsAt: paidThrough,
        offerCode: "operator_club_monthly",
        sourceId: "club-linked-academy-dispute",
        sourceKind: "subscription",
        startsAt: now,
      })));
    const dispute = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({
        commandId: randomUUID(),
        disputeId: "dp_linked_academy_lost",
        targetSourceRegistryId: sourceA,
      })));
    const resolveCommand = randomUUID();
    const resolveInput = {
      commandId: resolveCommand,
      holdSourceRegistryId: dispute.holdSourceRegistryId,
      resolution: "lost" as const,
    };
    const resolved = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute(resolveInput));
    expect(resolved.status).toBe("applied");
    const replay = await systemUnitOfWork(accountA, randomUUID(),
      new Date(now.getTime() + 1)).transaction((tx) =>
      tx.entitlements.resolveDispute(resolveInput));
    expect(replay).toEqual({ ...resolved, replayed: true });

    expect((await harness.database.pool.query<{
      academy_statuses: string[];
      club_statuses: string[];
      club_receipt: string;
      original_holds: number;
      follow_up_holds: number;
      incidents: number;
      event_type: string;
    }>(`select
        (select array_agg(distinct status order by status)
           from entitlement_grants where source_registry_id=$1) academy_statuses,
        (select array_agg(distinct status order by status)
           from entitlement_grants where source_registry_id=$2) club_statuses,
        (select status from commerce_fulfillment_receipts
           where source_registry_id=$2) club_receipt,
        (select count(*)::int from account_holds
           where source_registry_id=$3 and released_at is null) original_holds,
        (select count(*)::int from account_holds h
           join account_hold_sources hs on hs.id=h.source_registry_id
           where hs.source_kind='club_cancellation_reconciliation'
             and hs.target_source_registry_id=$2 and h.released_at is null)
          follow_up_holds,
        (select count(*)::int from commerce_reconciliations
           where account_id=$4 and command_kind='resolve_dispute'
             and incident_kind='linked_club_cancellation') incidents,
        (select type from outbox_events where event_id=$5) event_type`,
      [sourceA, club.sourceRegistryId, dispute.holdSourceRegistryId,
        accountA, resolveCommand],
    )).rows[0]).toEqual({
      academy_statuses: ["revoked"],
      club_statuses: ["revoked"],
      club_receipt: "fulfilled",
      original_holds: 0,
      follow_up_holds: 2,
      incidents: 1,
      event_type: "entitlements.reconciliation_required.v1",
    });
    const followUp = await harness.database.pool.query<{ id: string }>(
      `select id from commerce_reconciliations
       where account_id=$1 and command_kind='resolve_dispute'
         and incident_kind='linked_club_cancellation'`,
      [accountA],
    );
    const followUpId = followUp.rows[0]?.id;
    if (followUpId === undefined) {
      throw new Error("EXPECTED_LINKED_CLUB_CANCELLATION_RECONCILIATION");
    }
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.claimCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: followUpId,
      })));
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveCommerceReconciliation({
        commandId: randomUUID(),
        reconciliationId: followUpId,
        resolution: "club_cancelled",
        paidThroughAt: paidThrough,
        reason: "Provider confirmed the linked Club subscription cancellation",
      })));
    expect((await harness.database.pool.query<{
      receipt_status: string;
      incident_status: string;
      resolution_code: string;
      open_holds: number;
    }>(`select
        (select status from commerce_fulfillment_receipts
          where source_registry_id=$1) receipt_status,
        (select status from commerce_reconciliations where id=$2) incident_status,
        (select resolution_code from commerce_reconciliations where id=$2)
          resolution_code,
        (select count(*)::int from account_holds h
          join account_hold_sources hs on hs.id=h.source_registry_id
          where hs.source_kind='club_cancellation_reconciliation'
            and hs.source_id=$2::text and h.released_at is null) open_holds`,
      [club.sourceRegistryId, followUpId],
    )).rows[0]).toEqual({
      receipt_status: "cancelled",
      incident_status: "resolved_manual",
      resolution_code: "club_cancelled",
      open_holds: 0,
    });
    expect(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recoverClubPayment({
        commandId: randomUUID(),
        sourceRegistryId: club.sourceRegistryId,
        paidThroughAt: new Date(paidThrough.getTime() + 31 * 86_400_000),
      }))).toMatchObject({ status: "denied" });
  });

  it("finalizes a pending Academy refund when the linked Club refund arrives", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const club = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: new Date(now.getTime() + 31 * 86_400_000),
        offerCode: "operator_club_monthly",
        sourceId: "club-refund-finalizes-academy", sourceKind: "subscription",
        startsAt: now,
      })));
    const pending = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        reason: "Academy refund awaiting the linked Club provider refund",
      }));
    if (pending.status !== "applied" || pending.value.refundStatus !== "reconciliation") {
      throw new Error("EXPECTED_LINKED_REFUND_RECONCILIATION");
    }
    expect(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: randomUUID(), sourceRegistryId: club.sourceRegistryId,
        reason: "Provider confirmed the linked Club subscription refund",
      }))).toMatchObject({ status: "applied", value: { refundStatus: "refunded" } });
    expect((await harness.database.pool.query<{
      academy_status: string[]; club_status: string[]; incident_status: string;
      resolution_code: string; open_holds: number;
    }>(`select
        (select array_agg(distinct status order by status) from entitlement_grants
          where source_registry_id=$1) academy_status,
        (select array_agg(distinct status order by status) from entitlement_grants
          where source_registry_id=$2) club_status,
        (select status from commerce_reconciliations where id=$3) incident_status,
        (select resolution_code from commerce_reconciliations where id=$3)
          resolution_code,
        (select count(*)::int from account_holds h join account_hold_sources hs
          on hs.id=h.source_registry_id where hs.source_id=$3::text
            and h.released_at is null) open_holds`,
      [sourceA, club.sourceRegistryId, pending.value.reconciliationId])).rows[0])
      .toEqual({
        academy_status: ["refunded"],
        club_status: ["refunded"],
        incident_status: "resolved_refund",
        resolution_code: "club_refunded",
        open_holds: 0,
      });
  });

  it("blocks linked Club billing while an Academy refund is pending and opens a new epoch after abort", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const paidThrough = new Date(now.getTime() + 31 * 86_400_000);
    const club = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA,
        commandId: randomUUID(),
        endsAt: paidThrough,
        offerCode: "operator_club_monthly",
        sourceId: "club-linked-refund-abort",
        sourceKind: "subscription",
        startsAt: now,
      })));
    const refundReason = "Customer requested a linked Academy refund";
    const first = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: randomUUID(), sourceRegistryId: sourceA, reason: refundReason,
      }));
    expect(first).toMatchObject({ status: "applied", value: {
      refundStatus: "reconciliation", reconciliationId: expect.any(String),
    } });
    if (first.status !== "applied" || first.value.refundStatus !== "reconciliation") {
      throw new Error("EXPECTED_LINKED_REFUND_RECONCILIATION");
    }
    expect(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recoverClubPayment({
        commandId: randomUUID(), sourceRegistryId: club.sourceRegistryId,
        paidThroughAt: new Date(paidThrough.getTime() + 31 * 86_400_000),
      }))).toMatchObject({
        status: "denied", code: "CLUB_REFUND_RECONCILIATION_HELD",
      });
    expect(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.markClubPaymentFailed({
        commandId: randomUUID(), sourceRegistryId: club.sourceRegistryId,
        paidThroughAt: paidThrough,
      }))).toMatchObject({
        status: "denied", code: "CLUB_REFUND_RECONCILIATION_HELD",
      });
    const firstId = first.value.reconciliationId;
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.claimCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: firstId,
      })));
    const abortCommand = randomUUID();
    const abortInput = {
      commandId: abortCommand,
      reconciliationId: firstId,
      resolution: "abort_refund" as const,
      reason: "Customer withdrew the refund request",
    };
    const aborted = await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveCommerceReconciliation(abortInput));
    expect(aborted).toMatchObject({ status: "applied", value: {
      reconciliationId: firstId, status: "resolved_manual",
    } });
    expect((await harness.database.pool.query<{ resolution_code: string }>(
      "select resolution_code from commerce_reconciliations where id=$1",
      [firstId],
    )).rows[0]?.resolution_code).toBe("abort_refund");
    expect(await staffUnitOfWork(accountA, randomUUID()).transaction((tx) =>
      tx.entitlements.resolveCommerceReconciliation(abortInput)))
      .toEqual({ ...aborted, replayed: true });

    const second = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: randomUUID(), sourceRegistryId: sourceA, reason: refundReason,
      }));
    expect(second).toMatchObject({ status: "applied", value: {
      refundStatus: "reconciliation", reconciliationId: expect.any(String),
      reconciliationStatus: "open",
    } });
    if (second.status !== "applied" || second.value.refundStatus !== "reconciliation") {
      throw new Error("EXPECTED_SECOND_LINKED_REFUND_RECONCILIATION");
    }
    expect(second.value.reconciliationId).not.toBe(firstId);
    expect((await harness.database.pool.query<{
      first_status: string; first_holds: number; second_holds: number;
    }>(`select
        (select status from commerce_reconciliations where id=$1) first_status,
        (select count(*)::int from account_holds h join account_hold_sources hs
          on hs.id=h.source_registry_id where hs.source_id=$1::text and h.released_at is null)
          first_holds,
        (select count(*)::int from account_holds h join account_hold_sources hs
          on hs.id=h.source_registry_id where hs.source_id=$2 and h.released_at is null)
          second_holds`, [firstId, second.value.reconciliationId])).rows[0])
      .toEqual({ first_status: "resolved_manual", first_holds: 0, second_holds: 3 });
  });

  it("supersedes a pending linked Academy refund when the Academy dispute is lost", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const paidThrough = new Date(now.getTime() + 31 * 86_400_000);
    const club = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: paidThrough, offerCode: "operator_club_monthly",
        sourceId: "club-refund-superseded-by-dispute",
        sourceKind: "subscription", startsAt: now,
      })));
    const pending = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        reason: "Academy refund awaiting linked Club disposition",
      }));
    if (pending.status !== "applied" || pending.value.refundStatus !== "reconciliation") {
      throw new Error("EXPECTED_LINKED_REFUND_RECONCILIATION");
    }
    const dispute = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({
        commandId: randomUUID(), disputeId: "dp_supersede_linked_refund",
        targetSourceRegistryId: sourceA,
      })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({
        commandId: randomUUID(), holdSourceRegistryId: dispute.holdSourceRegistryId,
        resolution: "lost",
      })));
    expect((await harness.database.pool.query<{
      prior_status: string; prior_resolution: string; prior_holds: number;
      follow_up_holds: number; academy_status: string[]; club_status: string[];
    }>(`select
        (select status from commerce_reconciliations where id=$1) prior_status,
        (select resolution_code from commerce_reconciliations where id=$1) prior_resolution,
        (select count(*)::int from account_holds h join account_hold_sources hs
          on hs.id=h.source_registry_id where hs.source_id=$1::text and h.released_at is null)
          prior_holds,
        (select count(*)::int from account_holds h join account_hold_sources hs
          on hs.id=h.source_registry_id where hs.source_kind='club_cancellation_reconciliation'
            and hs.target_source_registry_id=$2 and h.released_at is null) follow_up_holds,
        (select array_agg(distinct status order by status) from entitlement_grants
          where source_registry_id=$3) academy_status,
        (select array_agg(distinct status order by status) from entitlement_grants
          where source_registry_id=$2) club_status`,
      [pending.value.reconciliationId, club.sourceRegistryId, sourceA])).rows[0])
      .toEqual({
        prior_status: "resolved_manual",
        prior_resolution: "superseded_by_dispute",
        prior_holds: 0,
        follow_up_holds: 2,
        academy_status: ["revoked"],
        club_status: ["revoked"],
      });
  });

  it("preserves a grace Club paid-through when a lost Academy dispute queues cancellation", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const paidThrough = new Date(now.getTime() + 31 * 86_400_000);
    const club = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: paidThrough, offerCode: "operator_club_monthly",
        sourceId: "club-grace-linked-dispute", sourceKind: "subscription",
        startsAt: now,
      })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.markClubPaymentFailed({
        commandId: randomUUID(), sourceRegistryId: club.sourceRegistryId,
        paidThroughAt: paidThrough,
      })));
    const dispute = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({
        commandId: randomUUID(), disputeId: "dp_grace_linked_academy_lost",
        targetSourceRegistryId: sourceA,
      })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({
        commandId: randomUUID(), holdSourceRegistryId: dispute.holdSourceRegistryId,
        resolution: "lost",
      })));
    const followUpId = (await harness.database.pool.query<{ id: string }>(
      `select id from commerce_reconciliations where account_id=$1
       and incident_kind='linked_club_cancellation'`, [accountA],
    )).rows[0]?.id;
    if (followUpId === undefined) throw new Error("EXPECTED_LINKED_CANCELLATION");
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.claimCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: followUpId,
      })));
    expect(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: followUpId,
        resolution: "club_cancelled", paidThroughAt: paidThrough,
        reason: "Provider confirmed cancellation at the original paid-through",
      }))).toMatchObject({ status: "applied", value: {
        reconciliationId: followUpId, status: "resolved_manual",
      } });
    expect((await harness.database.pool.query<{ resolution_code: string }>(
      "select resolution_code from commerce_reconciliations where id=$1",
      [followUpId],
    )).rows[0]?.resolution_code).toBe("club_cancelled");
  });

  it("finalizes an Academy refund without redundant Club work after cancellation", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const paidThrough = new Date(now.getTime() + 31 * 86_400_000);
    const club = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: paidThrough, offerCode: "operator_club_monthly",
        sourceId: "club-cancel-before-academy-refund",
        sourceKind: "subscription", startsAt: now,
      })));
    applied(await systemUnitOfWork().transaction((tx) => tx.entitlements.cancelClub({
      commandId: randomUUID(), sourceRegistryId: club.sourceRegistryId,
      paidThroughAt: paidThrough,
    })));
    expect(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        reason: "Academy refund after provider confirmed Club cancellation",
      }))).toMatchObject({ status: "applied", value: { refundStatus: "refunded" } });
    expect((await harness.database.pool.query<{
      club_receipt: string; club_status: string[]; incidents: number;
    }>(`select
        (select status from commerce_fulfillment_receipts where source_registry_id=$1)
          club_receipt,
        (select array_agg(distinct status order by status) from entitlement_grants
          where source_registry_id=$1) club_status,
        (select count(*)::int from commerce_reconciliations
          where incident_kind in ('linked_academy_refund','linked_club_cancellation')) incidents`,
      [club.sourceRegistryId])).rows[0]).toEqual({
        club_receipt: "cancelled", club_status: ["revoked"], incidents: 0,
      });
  });

  it("tracks a parked zero-grant linked Club through Academy refund disposition", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const blocker = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({
        commandId: randomUUID(), disputeId: "dp_park_linked_club",
        targetSourceRegistryId: sourceA,
      })));
    const paidThrough = new Date(now.getTime() + 31 * 86_400_000);
    const club = reconciled(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: paidThrough, offerCode: "operator_club_monthly",
        sourceId: "club-zero-grant-linked-refund", sourceKind: "subscription",
        startsAt: now,
      })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({
        commandId: randomUUID(), holdSourceRegistryId: blocker.holdSourceRegistryId,
        resolution: "won",
      })));
    const pending = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        reason: "Academy refund with a parked linked Club payment",
      }));
    if (pending.status !== "applied" || pending.value.refundStatus !== "reconciliation") {
      throw new Error("EXPECTED_LINKED_REFUND_RECONCILIATION");
    }
    const linkedReconciliationId = pending.value.reconciliationId;
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.claimCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: linkedReconciliationId,
      })));
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: linkedReconciliationId,
        resolution: "club_refunded",
        reason: "Provider refunded the parked linked Club payment",
      })));
    expect((await harness.database.pool.query<{
      receipt_status: string; parked_status: string; linked_status: string;
    }>(`select
        (select status from commerce_fulfillment_receipts where source_registry_id=$1)
          receipt_status,
        (select status from commerce_reconciliations where id=$2) parked_status,
        (select status from commerce_reconciliations where id=$3) linked_status`,
      [club.sourceRegistryId, club.reconciliationId,
        linkedReconciliationId])).rows[0]).toEqual({
          receipt_status: "refunded",
          parked_status: "resolved_refund",
          linked_status: "resolved_refund",
        });
  });

  it("keeps the parked Club incident actionable when a linked Academy refund is aborted", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const blocker = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({
        commandId: randomUUID(), disputeId: "dp_park_club_abort_refund",
        targetSourceRegistryId: sourceA,
      })));
    const club = reconciled(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: new Date(now.getTime() + 31 * 86_400_000),
        offerCode: "operator_club_monthly",
        sourceId: "club-parked-abort-refund", sourceKind: "subscription",
        startsAt: now,
      })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({
        commandId: randomUUID(), holdSourceRegistryId: blocker.holdSourceRegistryId,
        resolution: "won",
      })));
    const pending = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        reason: "Academy refund later withdrawn by the customer",
      }));
    if (pending.status !== "applied" || pending.value.refundStatus !== "reconciliation") {
      throw new Error("EXPECTED_LINKED_REFUND_RECONCILIATION");
    }
    const linkedReconciliationId = pending.value.reconciliationId;
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.claimCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: linkedReconciliationId,
      })));
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: linkedReconciliationId,
        resolution: "abort_refund", reason: "Customer withdrew the Academy refund",
      })));
    expect((await harness.database.pool.query<{
      receipt_status: string; parked_status: string; linked_status: string;
    }>(`select
        (select status from commerce_fulfillment_receipts where source_registry_id=$1)
          receipt_status,
        (select status from commerce_reconciliations where id=$2) parked_status,
        (select status from commerce_reconciliations where id=$3) linked_status`,
      [club.sourceRegistryId, club.reconciliationId,
        linkedReconciliationId])).rows[0]).toEqual({
          receipt_status: "reconciliation",
          parked_status: "open",
          linked_status: "resolved_manual",
        });
  });

  it("tracks a parked zero-grant linked Club through a lost Academy dispute", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const dispute = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({
        commandId: randomUUID(), disputeId: "dp_zero_grant_linked_club_lost",
        targetSourceRegistryId: sourceA,
      })));
    const paidThrough = new Date(now.getTime() + 31 * 86_400_000);
    const club = reconciled(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: paidThrough, offerCode: "operator_club_monthly",
        sourceId: "club-zero-grant-linked-lost", sourceKind: "subscription",
        startsAt: now,
      })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({
        commandId: randomUUID(), holdSourceRegistryId: dispute.holdSourceRegistryId,
        resolution: "lost",
      })));
    const followUpId = (await harness.database.pool.query<{ id: string }>(
      `select id from commerce_reconciliations where account_id=$1
       and incident_kind='linked_club_cancellation'`, [accountA],
    )).rows[0]?.id;
    if (followUpId === undefined) throw new Error("EXPECTED_LINKED_CANCELLATION");
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.claimCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: followUpId,
      })));
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: followUpId,
        resolution: "club_refunded",
        reason: "Provider refunded the parked linked Club charge after dispute loss",
      })));
    expect((await harness.database.pool.query<{
      receipt_status: string; parked_status: string; follow_up_status: string;
      open_follow_up_holds: number;
    }>(`select
        (select status from commerce_fulfillment_receipts where source_registry_id=$1)
          receipt_status,
        (select status from commerce_reconciliations where id=$2) parked_status,
        (select status from commerce_reconciliations where id=$3) follow_up_status,
        (select count(*)::int from account_holds h join account_hold_sources hs
          on hs.id=h.source_registry_id where hs.source_id=$3::text
            and h.released_at is null) open_follow_up_holds`,
      [club.sourceRegistryId, club.reconciliationId, followUpId])).rows[0])
      .toEqual({
        receipt_status: "refunded",
        parked_status: "resolved_refund",
        follow_up_status: "resolved_refund",
        open_follow_up_holds: 0,
      });
  });

  it("does not queue linked Club cancellation twice when Academy dispute loss follows cancellation", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const paidThrough = new Date(now.getTime() + 31 * 86_400_000);
    const club = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: paidThrough, offerCode: "operator_club_monthly",
        sourceId: "club-cancel-before-academy-lost", sourceKind: "subscription",
        startsAt: now,
      })));
    applied(await systemUnitOfWork().transaction((tx) => tx.entitlements.cancelClub({
      commandId: randomUUID(), sourceRegistryId: club.sourceRegistryId,
      paidThroughAt: paidThrough,
    })));
    const dispute = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({
        commandId: randomUUID(), disputeId: "dp_cancel_before_academy_lost",
        targetSourceRegistryId: sourceA,
      })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({
        commandId: randomUUID(), holdSourceRegistryId: dispute.holdSourceRegistryId,
        resolution: "lost",
      })));
    expect((await harness.database.pool.query<{
      linked_incidents: number; linked_holds: number; club_status: string[];
    }>(`select
        (select count(*)::int from commerce_reconciliations
          where incident_kind='linked_club_cancellation') linked_incidents,
        (select count(*)::int from account_holds h join account_hold_sources hs
          on hs.id=h.source_registry_id
          where hs.source_kind='club_cancellation_reconciliation'
            and h.released_at is null) linked_holds,
        (select array_agg(distinct status order by status) from entitlement_grants
          where source_registry_id=$1) club_status`, [club.sourceRegistryId])).rows[0])
      .toEqual({ linked_incidents: 0, linked_holds: 0, club_status: ["revoked"] });
  });

  it("targets the active Club rather than a parked duplicate during Academy refund", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const paidThrough = new Date(now.getTime() + 31 * 86_400_000);
    const activeClub = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: paidThrough, offerCode: "operator_club_monthly",
        sourceId: "club-active-before-parked-refund", sourceKind: "subscription",
        startsAt: now,
      })));
    const parkedClub = reconciled(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: paidThrough, offerCode: "operator_club_monthly",
        sourceId: "club-parked-duplicate-refund", sourceKind: "subscription",
        startsAt: now,
      })));
    const pending = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        reason: "Academy refund while a duplicate Club payment is parked",
      }));
    expect(pending).toMatchObject({ status: "applied", value: {
      refundStatus: "reconciliation",
      linkedClubSourceRegistryId: activeClub.sourceRegistryId,
    } });
    expect((await harness.database.pool.query<{
      academy_status: string[]; child_incidents: number; open_holds: number;
    }>(`select
        (select array_agg(distinct status order by status) from entitlement_grants
          where source_registry_id=$1) academy_status,
        (select count(*)::int from commerce_reconciliations
          where incident_kind='linked_academy_refund' and status='open') child_incidents,
        (select count(*)::int from account_holds h join account_hold_sources hs
          on hs.id=h.source_registry_id
          where hs.source_kind='academy_refund_reconciliation'
            and h.released_at is null) open_holds`, [sourceA])).rows[0])
      .toEqual({ academy_status: ["active"], child_incidents: 2, open_holds: 6 });
    applied(await systemUnitOfWork().transaction((tx) => tx.entitlements.cancelClub({
      commandId: randomUUID(), sourceRegistryId: activeClub.sourceRegistryId,
      paidThroughAt: paidThrough,
    })));
    const parkedChildId = (await harness.database.pool.query<{ id: string }>(
      `select id from commerce_reconciliations
       where incident_kind='linked_academy_refund'
         and target_source_registry_id=$1`, [parkedClub.sourceRegistryId],
    )).rows[0]?.id;
    if (parkedChildId === undefined) throw new Error("EXPECTED_PARKED_CHILD_INCIDENT");
    expect((await harness.database.pool.query<{
      academy_status: string[]; open_children: number;
    }>(`select
        (select array_agg(distinct status order by status) from entitlement_grants
          where source_registry_id=$1) academy_status,
        (select count(*)::int from commerce_reconciliations
          where incident_kind='linked_academy_refund'
            and status in ('open','claimed')) open_children`, [sourceA])).rows[0])
      .toEqual({ academy_status: ["active"], open_children: 1 });
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.claimCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: parkedChildId,
      })));
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveCommerceReconciliation({
        commandId: randomUUID(), reconciliationId: parkedChildId,
        resolution: "club_refunded",
        reason: "Provider refunded the remaining parked Club payment",
      })));
    expect((await harness.database.pool.query<{
      academy_status: string[]; active_status: string[]; parked_receipt: string;
      parked_grants: number; open_children: number; open_holds: number;
    }>(`select
        (select array_agg(distinct status order by status) from entitlement_grants
          where source_registry_id=$3) academy_status,
        (select array_agg(distinct status order by status) from entitlement_grants
          where source_registry_id=$1) active_status,
        (select status from commerce_fulfillment_receipts where source_registry_id=$2)
          parked_receipt,
        (select count(*)::int from entitlement_grants where source_registry_id=$2)
          parked_grants,
        (select count(*)::int from commerce_reconciliations
          where incident_kind='linked_academy_refund'
            and status in ('open','claimed')) open_children,
        (select count(*)::int from account_holds h join account_hold_sources hs
          on hs.id=h.source_registry_id
          where hs.source_kind='academy_refund_reconciliation'
            and h.released_at is null) open_holds`,
      [activeClub.sourceRegistryId, parkedClub.sourceRegistryId, sourceA])).rows[0])
      .toEqual({ academy_status: ["refunded"], active_status: ["revoked"],
        parked_receipt: "refunded", parked_grants: 0,
        open_children: 0, open_holds: 0 });
  });

  it("revokes the active Club rather than a parked duplicate on Academy dispute loss", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const paidThrough = new Date(now.getTime() + 31 * 86_400_000);
    const activeClub = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: paidThrough, offerCode: "operator_club_monthly",
        sourceId: "club-active-before-parked-lost", sourceKind: "subscription",
        startsAt: now,
      })));
    const parkedClub = reconciled(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: sourceA, commandId: randomUUID(),
        endsAt: paidThrough, offerCode: "operator_club_monthly",
        sourceId: "club-parked-duplicate-lost", sourceKind: "subscription",
        startsAt: now,
      })));
    const dispute = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({
        commandId: randomUUID(), disputeId: "dp_active_club_precedes_parked",
        targetSourceRegistryId: sourceA,
      })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({
        commandId: randomUUID(), holdSourceRegistryId: dispute.holdSourceRegistryId,
        resolution: "lost",
      })));
    const followUps = await harness.database.pool.query<{
      id: string; target_source_registry_id: string;
    }>(`select id,target_source_registry_id from commerce_reconciliations
        where incident_kind='linked_club_cancellation'
        order by target_source_registry_id`);
    expect(followUps.rows.map(({ target_source_registry_id }) =>
      target_source_registry_id).sort()).toEqual([
        activeClub.sourceRegistryId, parkedClub.sourceRegistryId,
      ].sort());
    for (const followUp of followUps.rows) {
      applied(await staffUnitOfWork().transaction((tx) =>
        tx.entitlements.claimCommerceReconciliation({
          commandId: randomUUID(), reconciliationId: followUp.id,
        })));
      applied(await staffUnitOfWork().transaction((tx) =>
        tx.entitlements.resolveCommerceReconciliation({
          commandId: randomUUID(), reconciliationId: followUp.id,
          ...(followUp.target_source_registry_id === activeClub.sourceRegistryId
            ? { resolution: "club_cancelled" as const, paidThroughAt: paidThrough }
            : { resolution: "club_refunded" as const }),
          reason: "Provider dispositioned every linked Club obligation",
        })));
    }
    expect((await harness.database.pool.query<{
      active_status: string[]; parked_receipt: string; parked_incident: string;
      open_follow_ups: number; open_holds: number;
    }>(`select
        (select array_agg(distinct status order by status) from entitlement_grants
          where source_registry_id=$1) active_status,
        (select status from commerce_fulfillment_receipts where source_registry_id=$2)
          parked_receipt,
        (select status from commerce_reconciliations where id=$3) parked_incident,
        (select count(*)::int from commerce_reconciliations
          where incident_kind='linked_club_cancellation'
            and status in ('open','claimed')) open_follow_ups,
        (select count(*)::int from account_holds h join account_hold_sources hs
          on hs.id=h.source_registry_id
          where hs.source_kind='club_cancellation_reconciliation'
            and h.released_at is null) open_holds`,
      [activeClub.sourceRegistryId, parkedClub.sourceRegistryId,
        parkedClub.reconciliationId])).rows[0])
      .toEqual({
        active_status: ["revoked"],
        parked_receipt: "refunded",
        parked_incident: "resolved_refund",
        open_follow_ups: 0,
        open_holds: 0,
      });
  });

  it("parks each duplicate setup payment as its own refundable financial receipt", async () => {
    await seedAccount(accountA);
    const first = recordedSetup(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recordBusinessOsSetupPurchase({
        commandId: randomUUID(), sourceId: "setup-epoch-first", purchasedAt: now,
      })));
    const secondAt = new Date(now.getTime() + 1);
    const second = recordedSetup(await systemUnitOfWork(
      accountA, randomUUID(), secondAt,
    ).transaction((tx) => tx.entitlements.recordBusinessOsSetupPurchase({
      commandId: randomUUID(), sourceId: "setup-epoch-second", purchasedAt: secondAt,
    })));
    expect(first).toMatchObject({ setupKind: "recorded", receiptStatus: "paid" });
    expect(second).toMatchObject({
      setupKind: "parked_receipt",
      receiptStatus: "paid_reconciliation",
      reconciliationId: expect.any(String),
    });
    expect(second.sourceRegistryId).not.toBe(first.sourceRegistryId);
    applied(await systemUnitOfWork(accountA, randomUUID(), secondAt).transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: randomUUID(),
        sourceRegistryId: second.sourceRegistryId,
        reason: "Duplicate setup charge refunded after reconciliation",
      })));
    expect((await harness.database.pool.query<{
      source_registry_id: string;
      status: string;
    }>(`select source_registry_id,status from business_os_setup_receipts
        order by created_at`)).rows).toEqual([
      { source_registry_id: first.sourceRegistryId, status: "paid" },
      { source_registry_id: second.sourceRegistryId, status: "refunded" },
    ]);
    expect((await harness.database.pool.query<{ status: string }>(
      "select status from commerce_reconciliations where id=$1",
      [second.reconciliationId],
    )).rows[0]?.status).toBe("resolved_refund");
  });

  it("promotes a parked setup epoch only after the prior paid epoch is terminal", async () => {
    await seedAccount(accountA);
    const first = recordedSetup(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recordBusinessOsSetupPurchase({
        commandId: randomUUID(), sourceId: "setup-promotion-first", purchasedAt: now,
      })));
    const secondAt = new Date(now.getTime() + 1);
    const second = recordedSetup(await systemUnitOfWork(accountA, randomUUID(), secondAt)
      .transaction((tx) => tx.entitlements.recordBusinessOsSetupPurchase({
        commandId: randomUUID(), sourceId: "setup-promotion-second", purchasedAt: secondAt,
      })));
    const deniedId = randomUUID();
    expect(await staffUnitOfWork(accountA, randomUUID(), secondAt).transaction((tx) =>
      tx.entitlements.reconcileBusinessOsSetup({
        commandId: deniedId,
        sourceRegistryId: second.sourceRegistryId,
        reason: "Second setup payment was validated before prior setup closed",
      }))).toMatchObject({ status: "denied", code: "BUSINESS_OS_SETUP_EPOCH_EXISTS" });
    expect(await commandEvidence(harness.database, deniedId))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    expect((await harness.database.pool.query<{ status: string }>(
      "select status from business_os_setup_receipts where source_registry_id=$1",
      [second.sourceRegistryId],
    )).rows[0]?.status).toBe("paid_reconciliation");

    applied(await systemUnitOfWork(accountA, randomUUID(), secondAt).transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: randomUUID(),
        sourceRegistryId: first.sourceRegistryId,
        reason: "Prior setup epoch was refunded before replacement promotion",
      })));
    expect(applied(await staffUnitOfWork(accountA, randomUUID(), secondAt)
      .transaction((tx) => tx.entitlements.reconcileBusinessOsSetup({
        commandId: randomUUID(),
        sourceRegistryId: second.sourceRegistryId,
        reason: "Replacement setup payment approved after prior epoch closed",
      })))).toEqual({ sourceRegistryId: second.sourceRegistryId, receiptStatus: "paid" });
  });

  it("keeps Business OS setup reconciliation blocked by commerce and activation holds", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const dispute = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({ commandId: randomUUID(),
        disputeId: "dp_setup_reconciliation_hold",
        targetSourceRegistryId: sourceA })));
    const setup = recordedSetup(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recordBusinessOsSetupPurchase({ commandId: randomUUID(),
        sourceId: "business-os-setup-held", purchasedAt: now })));
    expect(setup.receiptStatus).toBe("paid_reconciliation");
    const heldCommand = randomUUID();
    expect(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.reconcileBusinessOsSetup({ commandId: heldCommand,
        sourceRegistryId: setup.sourceRegistryId,
        reason: "Payment reviewed while dispute remains open" })))
      .toMatchObject({ status: "denied", code: "BUSINESS_OS_SETUP_HELD" });
    expect(await commandEvidence(harness.database, heldCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({ commandId: randomUUID(),
        holdSourceRegistryId: dispute.holdSourceRegistryId, resolution: "won" })));
    expect(applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.reconcileBusinessOsSetup({ commandId: randomUUID(),
        sourceRegistryId: setup.sourceRegistryId,
        reason: "Dispute released and payment reviewed" }))))
      .toEqual({ sourceRegistryId: setup.sourceRegistryId, receiptStatus: "paid" });
  });

  it("never fulfills a reconciled paid receipt after refund or lost dispute", async () => {
    await seedAccount(accountA);
    const suspend = async (reason: string) => applied(
      await staffUnitOfWork().transaction((tx) => tx.entitlements.suspendAccount({
        commandId: randomUUID(), reason,
      })),
    );
    const reactivate = async (reason: string) => applied(
      await staffUnitOfWork().transaction((tx) => tx.entitlements.reactivateAccount({
        commandId: randomUUID(), ownerMembershipId: membershipA, reason,
      })),
    );

    await suspend("Pause account before refund reconciliation test");
    const refundedSource = reconciled(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "business_os", sourceId: "bo-reconciliation-refunded",
        sourceKind: "subscription", startsAt: now,
        endsAt: new Date(now.getTime() + 86_400_000) })));
    expect(refundedSource.fulfillmentStatus).toBe("reconciliation");
    applied(await systemUnitOfWork().transaction((tx) => tx.entitlements.refundProduct({
      commandId: randomUUID(), sourceRegistryId: refundedSource.sourceRegistryId,
      reason: "Provider refund confirmed before entitlement fulfillment",
    })));
    await reactivate("Refund was recorded and account review completed");
    expect(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.reconcileProductFulfillment({ commandId: randomUUID(),
        sourceRegistryId: refundedSource.sourceRegistryId,
        reason: "Attempt to fulfill refunded receipt" })))
      .toMatchObject({ status: "denied", code: "PRODUCT_RECONCILIATION_UNAVAILABLE" });

    await suspend("Pause account before dispute reconciliation test");
    const lostSource = reconciled(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "business_os", sourceId: "bo-reconciliation-dispute-lost",
        sourceKind: "subscription", startsAt: now,
        endsAt: new Date(now.getTime() + 86_400_000) })));
    const dispute = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({ commandId: randomUUID(),
        disputeId: "dp_reconciliation_receipt_lost",
        targetSourceRegistryId: lostSource.sourceRegistryId })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({ commandId: randomUUID(),
        holdSourceRegistryId: dispute.holdSourceRegistryId, resolution: "lost" })));
    await reactivate("Lost dispute was recorded and account review completed");
    expect(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.reconcileProductFulfillment({ commandId: randomUUID(),
        sourceRegistryId: lostSource.sourceRegistryId,
        reason: "Attempt to fulfill dispute-lost receipt" })))
      .toMatchObject({ status: "denied", code: "PRODUCT_RECONCILIATION_UNAVAILABLE" });
    expect((await harness.database.pool.query<{ source_id: string; status: string }>(
      `select s.source_id,r.status from commerce_fulfillment_receipts r
       join entitlement_sources s on s.id=r.source_registry_id
       order by s.source_id`,
    )).rows).toEqual([
      { source_id: "bo-reconciliation-dispute-lost", status: "dispute_lost" },
      { source_id: "bo-reconciliation-refunded", status: "refunded" },
    ]);
  });

  it("suspends and reactivates accounts and revokes members through closed staff commands", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const invited = applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: sourceA, email: "lifecycle-member@example.test",
        tokenHash: Buffer.alloc(32, 61) })));
    const teammate = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.redeemInvitation({ commandId: randomUUID(),
        tokenHash: Buffer.alloc(32, 61), clerkUserId: "lifecycle-member",
        email: "lifecycle-member@example.test" })));

    const suspendCommand = randomUUID();
    const suspended = applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.suspendAccount({ commandId: suspendCommand,
        reason: "Risk review in progress" })));
    expect(suspended).toEqual({ accountId: accountA, status: "suspended" });
    expect(await commandEvidence(harness.database, suspendCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    const suspendedSetupCommand = randomUUID();
    const suspendedSetupInput = { commandId: suspendedSetupCommand,
      sourceId: "business-os-setup-suspended", purchasedAt: now };
    const suspendedSetup = recordedSetup(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recordBusinessOsSetupPurchase(suspendedSetupInput)));
    expect(suspendedSetup.receiptStatus).toBe("paid_reconciliation");
    expect(await systemUnitOfWork(accountA, randomUUID()).transaction((tx) =>
      tx.entitlements.recordBusinessOsSetupPurchase(suspendedSetupInput)))
      .toEqual({ status: "applied", replayed: true, value: suspendedSetup });
    await expect(new MemberEntitlementReadRepository(member.database,
      { now: () => now }).getEffectiveAccess(trustedMemberActor({
        kind: "member", actorId: identityA, accountId: accountA,
        clerkUserId: `user_${accountA}`, membershipId: membershipA,
        role: "owner", authenticatedAt: now,
      }))).rejects.toBeInstanceOf(Error);

    const reactivateCommand = randomUUID();
    expect(applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.reactivateAccount({ commandId: reactivateCommand,
        ownerMembershipId: membershipA, reason: "Risk review cleared" }))))
      .toEqual({ accountId: accountA, ownerMembershipId: membershipA,
        status: "active" });
    expect(applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.reconcileBusinessOsSetup({ commandId: randomUUID(),
        sourceRegistryId: suspendedSetup.sourceRegistryId,
        reason: "Payment and account ownership were reviewed" }))))
      .toEqual({ sourceRegistryId: suspendedSetup.sourceRegistryId,
        receiptStatus: "paid" });

    const revokeCommand = randomUUID();
    expect(applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.revokeMember({ commandId: revokeCommand,
        membershipId: teammate.membershipId,
        reason: "Workspace access removed by administrator" }))))
      .toMatchObject({ membershipId: teammate.membershipId,
        reservationId: invited.reservationId });
    expect(await commandEvidence(harness.database, revokeCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect((await harness.database.pool.query<{
      membership_status: string; seat_state: string;
    }>(`select m.status membership_status,r.state seat_state
       from memberships m join seat_reservations r on r.membership_id=m.id
       where m.id=$1`, [teammate.membershipId])).rows[0])
      .toEqual({ membership_status: "revoked", seat_state: "revoked" });
  });

  it("makes suspension and member revocation win blocked mutation and access races", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const suspendReady = deferred();
    const releaseSuspend = deferred();
    const suspendCommand = randomUUID();
    const reserveCommand = randomUUID();
    const suspendPending = staffUnitOfWork().transaction(async (tx) => {
      const outcome = await tx.entitlements.suspendAccount({
        commandId: suspendCommand,
        reason: "Suspension won the member mutation race",
      });
      suspendReady.resolve();
      await releaseSuspend.promise;
      return outcome;
    });
    await suspendReady.promise;
    const reservePending = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: reserveCommand,
        sourceRegistryId: sourceA,
        email: "suspension-race@example.test",
        tokenHash: Buffer.alloc(32, 113),
      }));
    const readPending = new MemberEntitlementReadRepository(member.database, {
      now: () => now,
    }).getEffectiveAccess(trustedMemberActor({
      kind: "member",
      actorId: identityA,
      accountId: accountA,
      clerkUserId: `user_${accountA}`,
      membershipId: membershipA,
      role: "owner",
      authenticatedAt: now,
    })).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await waitForAdvisoryKeyWaiters(
      harness.database,
      `syntholo-entitlement-account:${accountA}`,
      2,
    );
    releaseSuspend.resolve();
    expect((await suspendPending).status).toBe("applied");
    expect(await reservePending).toMatchObject({
      status: "denied",
      code: "ACCOUNT_INACTIVE",
    });
    const readResult = await readPending;
    expect(readResult.status).toBe("rejected");
    if (readResult.status !== "rejected") throw new Error("EXPECTED_ACCESS_DENIAL");
    expect(readResult.reason).toMatchObject({ code: "MEMBER_ACCESS_UNAVAILABLE" });
    expect(await commandEvidence(harness.database, reserveCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });

    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.reactivateAccount({
        commandId: randomUUID(),
        ownerMembershipId: membershipA,
        reason: "Reactivated to exercise the revocation race",
      })));
    const token = Buffer.alloc(32, 114);
    applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: randomUUID(),
        sourceRegistryId: sourceA,
        email: "revocation-race@example.test",
        tokenHash: token,
      })));
    const teammate = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.redeemInvitation({
        commandId: randomUUID(),
        tokenHash: token,
        clerkUserId: "revocation-race-teammate",
        email: "revocation-race@example.test",
      })));
    const revokeReady = deferred();
    const releaseRevoke = deferred();
    const revokeCommand = randomUUID();
    const transferCommand = randomUUID();
    const revokePending = staffUnitOfWork().transaction(async (tx) => {
      const outcome = await tx.entitlements.revokeMember({
        commandId: revokeCommand,
        membershipId: teammate.membershipId,
        reason: "Member revocation won the ownership-transfer race",
      });
      revokeReady.resolve();
      await releaseRevoke.promise;
      return outcome;
    });
    await revokeReady.promise;
    const transferPending = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.transferOwnership({
        commandId: transferCommand,
        targetMembershipId: teammate.membershipId,
        reason: "Attempted transfer while staff revoked the target",
      }));
    await waitForAdvisoryKeyWaiters(
      harness.database,
      `syntholo-entitlement-account:${accountA}`,
      1,
    );
    releaseRevoke.resolve();
    expect((await revokePending).status).toBe("applied");
    expect(await transferPending).toMatchObject({
      status: "denied",
      code: "ACTIVE_TEAMMATE_REQUIRED",
    });
    expect(await commandEvidence(harness.database, transferCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
  });

  it("serializes teammate access and staff revocation in both lock orders", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const redeemTeammate = async (
      tokenByte: number,
      clerkUserId: string,
      email: string,
    ) => {
      const tokenHash = Buffer.alloc(32, tokenByte);
      applied(await ownerUnitOfWork().transaction((tx) =>
        tx.entitlements.reservePendingSeat({
          commandId: randomUUID(), sourceRegistryId: sourceA, email, tokenHash,
        })));
      return applied(await systemUnitOfWork().transaction((tx) =>
        tx.entitlements.redeemInvitation({
          commandId: randomUUID(), tokenHash, clerkUserId, email,
        })));
    };
    const actorFor = (
      teammate: Readonly<{ identityId: string; membershipId: string }>,
      clerkUserId: string,
    ) => trustedMemberActor({
      kind: "member" as const,
      actorId: teammate.identityId,
      accountId: accountA,
      clerkUserId,
      membershipId: teammate.membershipId,
      role: "teammate" as const,
      authenticatedAt: now,
    });
    const readerFirstTeammate = await redeemTeammate(
      145, "reader-first-teammate", "reader-first-teammate@example.test",
    );
    const readerFirstActor = actorFor(readerFirstTeammate, "reader-first-teammate");
    const barrierKey = "task8-teammate-reader-first-revocation";
    const blocker = await harness.database.pool.connect();
    let originalRenamed = false;
    let wrapperCreated = false;
    try {
      await harness.database.pool.query(
        `alter function syntholo_member_entitlement_snapshot(uuid,uuid,uuid)
           rename to syntholo_member_entitlement_snapshot_impl`,
      );
      originalRenamed = true;
      await harness.database.pool.query(`
        create function syntholo_member_entitlement_snapshot(
          p_account uuid,p_membership uuid,p_actor uuid)
        returns jsonb language plpgsql security definer
        set search_path=pg_catalog,public as $fn$
        declare v_snapshot jsonb;
        begin
          v_snapshot:=syntholo_member_entitlement_snapshot_impl(
            p_account,p_membership,p_actor);
          perform pg_advisory_xact_lock(
            hashtextextended('task8-teammate-reader-first-revocation',0));
          return v_snapshot;
        end $fn$;
        revoke all on function syntholo_member_entitlement_snapshot(uuid,uuid,uuid)
          from public;
        grant execute on function syntholo_member_entitlement_snapshot(uuid,uuid,uuid)
          to syntholo_member_api,syntholo_migrator
      `);
      wrapperCreated = true;
      await blocker.query(
        "select pg_advisory_lock(hashtextextended($1,0))",
        [barrierKey],
      );
      const repository = new MemberEntitlementReadRepository(member.database, {
        now: () => now,
      });
      const readerFirst = repository.getEffectiveAccess(readerFirstActor);
      await waitForAdvisoryKeyWaiters(harness.database, barrierKey, 1);
      const revokeCommand = randomUUID();
      const revokePending = staffUnitOfWork().transaction((tx) =>
        tx.entitlements.revokeMember({
          commandId: revokeCommand,
          membershipId: readerFirstTeammate.membershipId,
          reason: "Staff revocation waited for the in-flight access snapshot",
        }));
      await waitForAdvisoryKeyWaiters(
        harness.database,
        `syntholo-entitlement-account:${accountA}`,
        1,
      );
      await blocker.query(
        "select pg_advisory_unlock(hashtextextended($1,0))",
        [barrierKey],
      );
      const before = await readerFirst;
      expect(before.capabilities.academy_course).toBe(true);
      expect(before.reservedSeats).toBe(2);
      expect((await revokePending).status).toBe("applied");
      await expect(repository.getEffectiveAccess(readerFirstActor))
        .rejects.toMatchObject({ code: "MEMBER_ACCESS_UNAVAILABLE" });
      expect(await commandEvidence(harness.database, revokeCommand))
        .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    } finally {
      await blocker.query(
        "select pg_advisory_unlock(hashtextextended($1,0))",
        [barrierKey],
      ).catch(() => undefined);
      blocker.release();
      if (wrapperCreated) {
        await harness.database.pool.query(
          "drop function syntholo_member_entitlement_snapshot(uuid,uuid,uuid)",
        );
      }
      if (originalRenamed) {
        await harness.database.pool.query(
          `alter function syntholo_member_entitlement_snapshot_impl(uuid,uuid,uuid)
             rename to syntholo_member_entitlement_snapshot`,
        );
      }
    }

    const revokeFirstTeammate = await redeemTeammate(
      146, "revoke-first-teammate", "revoke-first-teammate@example.test",
    );
    const revokeFirstActor = actorFor(revokeFirstTeammate, "revoke-first-teammate");
    const revokeReady = deferred();
    const releaseRevoke = deferred();
    const revokeCommand = randomUUID();
    const revokeFirst = staffUnitOfWork().transaction(async (tx) => {
      const result = await tx.entitlements.revokeMember({
        commandId: revokeCommand,
        membershipId: revokeFirstTeammate.membershipId,
        reason: "Staff revocation committed before the access snapshot began",
      });
      revokeReady.resolve();
      await releaseRevoke.promise;
      return result;
    });
    await revokeReady.promise;
    const readAfter = new MemberEntitlementReadRepository(member.database, {
      now: () => now,
    }).getEffectiveAccess(revokeFirstActor).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await waitForAdvisoryKeyWaiters(
      harness.database,
      `syntholo-entitlement-account:${accountA}`,
      1,
    );
    releaseRevoke.resolve();
    expect((await revokeFirst).status).toBe("applied");
    const after = await readAfter;
    expect(after.status).toBe("rejected");
    if (after.status !== "rejected") throw new Error("EXPECTED_REVOKED_ACCESS_DENIAL");
    expect(after.reason).toMatchObject({ code: "MEMBER_ACCESS_UNAVAILABLE" });
    expect(await commandEvidence(harness.database, revokeCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
  });

  it("appoints an eligible owner while reactivating an ownerless suspended account", async () => {
    await seedAccount(accountA);
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.grantAdministrative({ commandId: randomUUID(),
        capability: "academy_course", startsAt: now, endsAt: null,
        reason: "Temporary administrative course access during account review" })));
    const ownerlessMember = randomUUID();
    const ownerlessIdentity = randomUUID();
    await inTransaction(harness.database.pool, async (client) => {
      await client.query(
        `insert into member_identities(id,account_id,provider,provider_user_id,
         email,created_at,updated_at)
         values($1,$2,'clerk',$3,'appointed@example.test',$4,$4)`,
        [ownerlessIdentity, accountA, `appointed_${accountA}`, now],
      );
      await client.query(
        `insert into memberships(id,account_id,member_identity_id,role,status,
         created_at,updated_at)
         values($1,$2,$3,'teammate','revoked',$4,$4)`,
        [ownerlessMember, accountA, ownerlessIdentity, now],
      );
      await client.query(
        "update accounts set status='suspended',updated_at=$2 where id=$1",
        [accountA, now],
      );
      await client.query(
        `update memberships set status='revoked',role='teammate',updated_at=$2
         where account_id=$1 and role='owner'`,
        [accountA, now],
      );
    });
    const result = applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.reactivateAccount({
        commandId: randomUUID(),
        ownerMembershipId: ownerlessMember,
        reason: "Staff verified and appointed the replacement owner",
      })));
    expect(result).toEqual({
      accountId: accountA,
      ownerMembershipId: ownerlessMember,
      status: "active",
    });
    expect((await harness.database.pool.query<{
      active_owners: number;
      active_seats: number;
      status: string;
    }>(`select a.status,
        count(distinct m.id) filter(where m.role='owner' and m.status='active')::int active_owners,
        (select count(*)::int from seat_reservations r
          where r.account_id=a.id and r.state='active') active_seats
       from accounts a left join memberships m on m.account_id=a.id
       where a.id=$1 group by a.id,a.status`, [accountA])).rows[0])
      .toEqual({ active_owners: 1, active_seats: 0, status: "active" });
  });

  it("grants revokes and restores administrative access through closed staff commands", async () => {
    await seedAccount(accountA);
    const startsAt = now;
    const endsAt = new Date(now.getTime() + 30 * 86_400_000);
    const grantCommand = randomUUID();
    const grantInput = { commandId: grantCommand, capability: "support" as const,
      startsAt, endsAt, reason: "Customer success service credit" };
    const first = applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.grantAdministrative(grantInput)));
    const replay = await staffUnitOfWork(accountA, randomUUID()).transaction((tx) =>
      tx.entitlements.grantAdministrative(grantInput));
    expect(replay).toEqual({ status: "applied", replayed: true, value: first });
    expect(await commandEvidence(harness.database, grantCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });

    const revokeCommand = randomUUID();
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.revokeAdministrative({ commandId: revokeCommand,
        grantId: first.grantId, reason: "Credit withdrawn after review" })));
    const restoreCommand = randomUUID();
    const restored = applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.restoreAdministrative({ commandId: restoreCommand,
        terminalGrantId: first.grantId, startsAt: now, endsAt,
        reason: "Approved restoration after review" })));
    expect(restored.grantId).not.toBe(first.grantId);
    expect(restored.sourceRegistryId).not.toBe(first.sourceRegistryId);

    const rows = await harness.database.pool.query<{
      id: string; restores_grant_id: string | null; source_registry_id: string;
      status: string;
    }>(`select g.id,g.source_registry_id,g.status,r.terminal_grant_id restores_grant_id
        from entitlement_grants g left join administrative_grant_restorations r
          on r.new_source_registry_id=g.source_registry_id
        where g.id=any($1::uuid[])
        order by (r.terminal_grant_id is not null),g.id`,
    [[first.grantId, restored.grantId]]);
    expect(rows.rows).toEqual([
      { id: first.grantId, restores_grant_id: null,
        source_registry_id: first.sourceRegistryId, status: "revoked" },
      { id: restored.grantId, restores_grant_id: first.grantId,
        source_registry_id: restored.sourceRegistryId, status: "active" },
    ]);
    const audit = await harness.database.pool.query<{
      operator_reason: string; public_reason: string | null;
    }>(`select payload->>'operatorReason' operator_reason,
          payload->>'reason' public_reason from audit_events where target_id=$1`,
    [restoreCommand]);
    expect(audit.rows).toEqual([{
      operator_reason: "Approved restoration after review", public_reason: null,
    }]);
  });

  it("commits typed staff administrative denials without lifecycle mutation", async () => {
    await seedAccount(accountA);
    await harness.database.pool.query(
      `insert into staff_identities(id,provider_user_id,role,permissions) values
       ('30000000-0000-4000-8000-000000000002','coach','coach',
         array['entitlements:manage']),
       ('30000000-0000-4000-8000-000000000003','admin-no-permission','admin',
         array[]::text[]),
       ('30000000-0000-4000-8000-000000000004','stale-admin','admin',
         array['entitlements:manage'])`,
    );
    const actors: StaffActor[] = [
      trustedStaffActor({ kind: "staff",
        actorId: "30000000-0000-4000-8000-000000000002",
        workosUserId: "coach", staffId: "30000000-0000-4000-8000-000000000002",
        role: "coach", permissions: Object.freeze(["entitlements:manage"]),
        authenticatedAt: now }),
      trustedStaffActor({ kind: "staff",
        actorId: "30000000-0000-4000-8000-000000000003",
        workosUserId: "admin-no-permission",
        staffId: "30000000-0000-4000-8000-000000000003",
        role: "admin", permissions: Object.freeze([]), authenticatedAt: now }),
      trustedStaffActor({ kind: "staff",
        actorId: "30000000-0000-4000-8000-000000000004",
        workosUserId: "stale-admin", staffId: "30000000-0000-4000-8000-000000000004",
        role: "admin", permissions: Object.freeze(["entitlements:manage"]),
        authenticatedAt: new Date(now.getTime() - 300_001) }),
    ];
    const expected = ["STAFF_ADMIN_REQUIRED", "STAFF_PERMISSION_REQUIRED",
      "RECENT_AUTH_REQUIRED"];
    for (const [index, actor] of actors.entries()) {
      const commandId = randomUUID();
      const outcome = await staffUnitOfWork(accountA, randomUUID(), now, actor)
        .transaction((tx) => tx.entitlements.grantAdministrative({
          commandId, capability: "support", startsAt: now, endsAt: null,
          reason: "Permission boundary test",
        }));
      expect(outcome).toMatchObject({ status: "denied", code: expected[index] });
      expect(await commandEvidence(harness.database, commandId))
        .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    }
    expect((await harness.database.pool.query<{ count: number }>(
      "select count(*)::int count from entitlement_grants where source_kind='administrative'",
    )).rows[0]?.count).toBe(0);
  });

  it("does not treat a structurally forged actor date as trusted recent auth", async () => {
    await seedAccount(accountA);
    const commandId = randomUUID();
    const forged = createUnitOfWork(staff.database, {
      accountId: accountA,
      actor: {
        kind: "staff",
        actorId: "30000000-0000-4000-8000-000000000001",
        workosUserId: "workos-admin",
        staffId: "30000000-0000-4000-8000-000000000001",
        role: "admin",
        permissions: Object.freeze(["entitlements:manage"]),
        authenticatedAt: new Date(now),
      },
      correlationId: randomUUID(),
      clock: { now: () => now },
    });
    expect(await forged.transaction((tx) =>
      tx.entitlements.grantAdministrative({
        commandId,
        capability: "support",
        startsAt: now,
        endsAt: null,
        reason: "Forged public date must not establish recent authentication",
      }))).toEqual({
      status: "denied", code: "RECENT_AUTH_REQUIRED", replayed: false,
    });
    expect(await commandEvidence(harness.database, commandId))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    expect((await harness.database.pool.query<{ count: number }>(
      `select count(*)::int count from entitlement_grants
       where account_id=$1 and source_kind='administrative'`, [accountA],
    )).rows[0]?.count).toBe(0);
  });

  it("rejects direct administrative Business OS grants at the database boundary", async () => {
    await seedAccount(accountA);
    const sourceRegistryId = randomUUID();
    await harness.database.pool.query(
      `insert into entitlement_sources
        (id,account_id,source_kind,source_id,offer_code,provenance,created_at)
       values($1,$2,'administrative','manual-business-os',null,'test',$3)`,
      [sourceRegistryId, accountA, now],
    );
    await expect(harness.database.pool.query(
      `insert into entitlement_grants
        (account_id,source_registry_id,source_kind,source_id,offer_code,
         capability,status,starts_at,ends_at,provenance,created_at,updated_at)
       values($1,$2,'administrative','manual-business-os',null,
         'business_os','active',$3,$4,'test',$3,$3)`,
      [accountA, sourceRegistryId, now, new Date(now.getTime() + 86_400_000)],
    )).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23514");
  });

  it("converges concurrent cross-account owner claims for one Clerk subject", async () => {
    await seedAccount(accountA, false);
    await seedAccount(accountB, false);
    const commandA = randomUUID();
    const commandB = randomUUID();
    const blocker = await harness.database.pool.connect();
    await harness.database.pool.query(`
      create function syntholo_test_identity_barrier() returns trigger
      language plpgsql set search_path=pg_catalog as $fn$
      begin
        perform pg_advisory_xact_lock(hashtextextended('task8-identity-race',0));
        return new;
      end $fn$;
      revoke all on function syntholo_test_identity_barrier() from public;
      create trigger syntholo_test_identity_barrier before insert on member_identities
        for each row when (new.provider_user_id='shared-owner-subject')
        execute function syntholo_test_identity_barrier()
    `);
    await blocker.query(
      "select pg_advisory_lock(hashtextextended('task8-identity-race',0))",
    );
    const pendingA = systemUnitOfWork(accountA).transaction((tx) =>
      tx.entitlements.establishOwner({ commandId: commandA,
        clerkUserId: "shared-owner-subject", email: "shared-owner@example.test" }));
    const pendingB = systemUnitOfWork(accountB).transaction((tx) =>
      tx.entitlements.establishOwner({ commandId: commandB,
        clerkUserId: "shared-owner-subject", email: "shared-owner@example.test" }));
    await waitForAdvisoryKeyWaiters(harness.database, "task8-identity-race", 2);
    await blocker.query(
      "select pg_advisory_unlock(hashtextextended('task8-identity-race',0))",
    );
    const [claimA, claimB] = await Promise.all([pendingA, pendingB]);
    blocker.release();
    await harness.database.pool.query(`
      drop trigger syntholo_test_identity_barrier on member_identities;
      drop function syntholo_test_identity_barrier()
    `);
    expect([claimA.status, claimB.status].sort()).toEqual(["applied", "denied"]);
    expect([claimA, claimB].find(({ status }) => status === "denied"))
      .toMatchObject({ code: "IDENTITY_ALREADY_CLAIMED" });
    expect(await commandEvidence(harness.database, commandA)).toEqual({
      decisions: 1, audits: 1, outbox: claimA.status === "applied" ? 1 : 0,
    });
    expect(await commandEvidence(harness.database, commandB)).toEqual({
      decisions: 1, audits: 1, outbox: claimB.status === "applied" ? 1 : 0,
    });
    expect((await harness.database.pool.query<{ count: number }>(
      `select count(*)::int count from member_identities
       where provider='clerk' and provider_user_id='shared-owner-subject'`,
    )).rows[0]?.count).toBe(1);
    const losingAccount = claimA.status === "denied" ? accountA : accountB;
    expect((await harness.database.pool.query<{
      memberships: number;
      owner_established_at: Date | null;
      seats: number;
    }>(`select a.owner_established_at,
        (select count(*)::int from memberships m
          where m.account_id=a.id) memberships,
        (select count(*)::int from seat_reservations r
          where r.account_id=a.id) seats
       from accounts a where a.id=$1`, [losingAccount])).rows[0])
      .toEqual({ memberships: 0, owner_established_at: null, seats: 0 });
  });

  it("establishes exactly one Academy owner and activates slot one", async () => {
    await seedAccount(accountA, false);
    await seedAcademyBundle(harness.database);
    const claim = applied(await systemUnitOfWork().transaction((tx) => tx.entitlements.establishOwner({
      commandId: randomUUID(),
      clerkUserId: "academy_owner",
      email: "owner@example.test",
    })));
    expect(claim.seatActivated).toBe(true);
    const seat = await harness.database.pool.query(
      "select slot,state,invitation_id from seat_reservations",
    );
    expect(seat.rows).toEqual([{ slot: 1, state: "active", invitation_id: null }]);
  });

  it("rejects zero or two owners once an active account is established", async () => {
    await seedAccount(accountA);
    await expect(inTransaction(harness.database.pool, async (client) => {
      await client.query(
        "update memberships set status='revoked' where account_id=$1",
        [accountA],
      );
    })).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "23514");
  });

  it("member sees only scoped grants holds and seats and cannot forge authorities", async () => {
    await seedAccount(accountA);
    await seedAccount(accountB);
    await seedAcademyBundle(harness.database);
    await member.database.transaction(async (tx) => {
      await tx.execute(
        (await import("drizzle-orm")).sql`select set_config('app.account_id', ${accountA}, true)`,
      );
      const visible = await tx.execute(
        (await import("drizzle-orm")).sql`select account_id from entitlement_grants`,
      );
      expect(visible.rows).toHaveLength(3);
      await expect(tx.execute((await import("drizzle-orm")).sql`
        update entitlement_grants set status='revoked'
      `)).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "42501");
    });
    await member.database.transaction(async (tx) => {
      await tx.execute(
        (await import("drizzle-orm")).sql`select set_config('app.account_id', ${accountA}, true)`,
      );
      await expect(tx.execute((await import("drizzle-orm")).sql`
        select * from access_decision_audit
      `)).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "42501");
    });
  });

  it("loads one repeatable-read read-only scoped entitlement snapshot", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const repository = new MemberEntitlementReadRepository(member.database, {
      now: () => now,
    });
    const access = await repository.getEffectiveAccess({
      kind: "member",
      actorId: identityA,
      accountId: accountA,
      clerkUserId: `user_${accountA}`,
      membershipId: membershipA,
      role: "owner",
      authenticatedAt: now,
    });
    expect(access.accountId).toBe(accountA);
    expect(access.capabilities).toEqual({
      academy_course: true,
      support: false,
      circle_write: false,
      operator_club: false,
      business_os: false,
    });
    expect(access.reservedSeats).toBe(1);
    await expect(repository.getEffectiveAccess({
      kind: "member",
      actorId: identityA,
      accountId: accountB,
      clerkUserId: `user_${accountA}`,
      membershipId: membershipA,
      role: "owner",
      authenticatedAt: now,
    })).rejects.toThrow("MEMBER_ACCESS_UNAVAILABLE");
  });

  it("returns an all-before snapshot when a lost-dispute write waits behind the reader", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const dispute = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({
        commandId: randomUUID(),
        disputeId: "dp_reader_first_snapshot",
        targetSourceRegistryId: sourceA,
      })));
    const barrierKey = "task8-reader-first-snapshot";
    const blocker = await harness.database.pool.connect();
    let originalRenamed = false;
    let wrapperCreated = false;
    try {
      await harness.database.pool.query(
        `alter function syntholo_member_entitlement_snapshot(uuid,uuid,uuid)
           rename to syntholo_member_entitlement_snapshot_impl`,
      );
      originalRenamed = true;
      await harness.database.pool.query(`
        create function syntholo_member_entitlement_snapshot(
          p_account uuid,p_membership uuid,p_actor uuid)
        returns jsonb language plpgsql security definer
        set search_path=pg_catalog,public as $fn$
        declare v_snapshot jsonb;
        begin
          v_snapshot:=syntholo_member_entitlement_snapshot_impl(
            p_account,p_membership,p_actor);
          perform pg_advisory_xact_lock(
            hashtextextended('task8-reader-first-snapshot',0));
          return v_snapshot;
        end $fn$;
        revoke all on function syntholo_member_entitlement_snapshot(uuid,uuid,uuid)
          from public;
        grant execute on function syntholo_member_entitlement_snapshot(uuid,uuid,uuid)
          to syntholo_member_api,syntholo_migrator
      `);
      wrapperCreated = true;
      await blocker.query(
        "select pg_advisory_lock(hashtextextended($1,0))",
        [barrierKey],
      );
      const repository = new MemberEntitlementReadRepository(member.database, {
        now: () => now,
      });
      const actor = trustedMemberActor({
        kind: "member" as const,
        actorId: identityA,
        accountId: accountA,
        clerkUserId: `user_${accountA}`,
        membershipId: membershipA,
        role: "owner" as const,
        authenticatedAt: now,
      });
      const readPending = repository.getEffectiveAccess(actor);
      await waitForAdvisoryKeyWaiters(harness.database, barrierKey, 1);
      const resolveCommand = randomUUID();
      const lostPending = systemUnitOfWork().transaction((tx) =>
        tx.entitlements.resolveDispute({
          commandId: resolveCommand,
          holdSourceRegistryId: dispute.holdSourceRegistryId,
          resolution: "lost",
        }));
      await waitForAdvisoryKeyWaiters(
        harness.database,
        `syntholo-entitlement-account:${accountA}`,
        1,
      );
      await blocker.query(
        "select pg_advisory_unlock(hashtextextended($1,0))",
        [barrierKey],
      );
      const before = await readPending;
      expect(before.capabilities.academy_course).toBe(true);
      expect(before.holds).toEqual([
        "commerce", "seat_changes", "business_os_activation",
      ]);
      expect(before.reservedSeats).toBe(1);
      expect((await lostPending).status).toBe("applied");
      const after = await repository.getEffectiveAccess(actor);
      expect(after.capabilities.academy_course).toBe(false);
      expect(after.holds).toEqual([]);
      expect(after.reservedSeats).toBe(0);
      expect(await commandEvidence(harness.database, resolveCommand))
        .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    } finally {
      await blocker.query(
        "select pg_advisory_unlock(hashtextextended($1,0))",
        [barrierKey],
      ).catch(() => undefined);
      blocker.release();
      if (wrapperCreated) {
        await harness.database.pool.query(
          "drop function syntholo_member_entitlement_snapshot(uuid,uuid,uuid)",
        );
      }
      if (originalRenamed) {
        await harness.database.pool.query(
          `alter function syntholo_member_entitlement_snapshot_impl(uuid,uuid,uuid)
             rename to syntholo_member_entitlement_snapshot`,
        );
      }
    }
  });

  it("starts the read snapshot after a lost-dispute writer commits first", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const dispute = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({
        commandId: randomUUID(),
        disputeId: "dp_writer_first_snapshot",
        targetSourceRegistryId: sourceA,
      })));
    const writerReady = deferred();
    const releaseWriter = deferred();
    const writerPending = systemUnitOfWork().transaction(async (tx) => {
      const outcome = await tx.entitlements.resolveDispute({
        commandId: randomUUID(),
        holdSourceRegistryId: dispute.holdSourceRegistryId,
        resolution: "lost",
      });
      writerReady.resolve();
      await releaseWriter.promise;
      return outcome;
    });
    await writerReady.promise;
    const readPending = new MemberEntitlementReadRepository(member.database, {
      now: () => now,
    }).getEffectiveAccess(trustedMemberActor({
      kind: "member",
      actorId: identityA,
      accountId: accountA,
      clerkUserId: `user_${accountA}`,
      membershipId: membershipA,
      role: "owner",
      authenticatedAt: now,
    }));
    await waitForAdvisoryKeyWaiters(
      harness.database,
      `syntholo-entitlement-account:${accountA}`,
      1,
    );
    releaseWriter.resolve();
    expect((await writerPending).status).toBe("applied");
    const access = await readPending;
    expect(access.capabilities.academy_course).toBe(false);
    expect(access.holds).toEqual([]);
    expect(access.reservedSeats).toBe(0);
  });

  it("decision audit is append-only and denied decisions commit without mutation/outbox", async () => {
    await seedAccount(accountA);
    const uow = createUnitOfWork(member.database, {
      accountId: accountA,
      actor: {
        kind: "member", actorId: identityA, accountId: accountA,
        clerkUserId: "user", membershipId: membershipA, role: "owner",
        authenticatedAt: now,
      },
      correlationId: "10000000-0000-4000-8000-000000000091",
      clock: { now: () => now },
    });
    const denied = await uow.transaction((tx) => tx.entitlements.recordDecision({
      commandId: "10000000-0000-4000-8000-000000000092",
      checkKind: "hold:seat_changes", allowed: false,
      reasonCode: "SEAT_CHANGES_HELD", sourceIds: [],
      snapshot: { grants: [], holds: [], seats: [] },
    }));
    expect(denied.allowed).toBe(false);
    const counts = await harness.database.pool.query(
      `select
       (select count(*)::int from access_decision_audit where command_id=$1) decisions,
       (select snapshot_version from access_decision_audit where command_id=$1) snapshot_version,
       (select snapshot_hash from access_decision_audit where command_id=$1) snapshot_hash,
       (select count(*)::int from outbox_events where event_id=$1) outbox`,
      ["10000000-0000-4000-8000-000000000092"],
    );
    expect(counts.rows[0]).toEqual({
      decisions: 1,
      snapshot_version: 1,
      snapshot_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      outbox: 0,
    });
    await expect(harness.database.pool.query(
      "update access_decision_audit set reason_code='changed'",
    )).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "55000");
  });

  it("allowed decisions roll back with a later transaction failure", async () => {
    await seedAccount(accountA);
    const uow = createUnitOfWork(member.database, {
      accountId: accountA,
      actor: {
        kind: "member", actorId: identityA, accountId: accountA,
        clerkUserId: "user", membershipId: membershipA, role: "owner",
        authenticatedAt: now,
      },
      correlationId: "10000000-0000-4000-8000-000000000091",
      clock: { now: () => now },
    });
    await expect(uow.transaction(async (tx) => {
      await tx.entitlements.recordDecision({
        commandId: "10000000-0000-4000-8000-000000000092",
        checkKind: "capability:academy_course", allowed: true,
        reasonCode: "ACADEMY_ALLOWED", sourceIds: [],
      });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    const count = await harness.database.pool.query(
      "select count(*)::int count from access_decision_audit where command_id=$1",
      ["10000000-0000-4000-8000-000000000092"],
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it("rolls back an applied command mutation decision audit and outbox together", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const commandId = randomUUID();
    await expect(ownerUnitOfWork().transaction(async (tx) => {
      const outcome = await tx.entitlements.reservePendingSeat({
        commandId,
        sourceRegistryId: sourceA,
        email: "atomic-rollback@example.test",
        tokenHash: Buffer.alloc(32, 115),
      });
      expect(outcome.status).toBe("applied");
      throw new Error("force-command-rollback");
    })).rejects.toThrow("force-command-rollback");
    expect((await harness.database.pool.query<{
      audits: number;
      commands: number;
      decisions: number;
      invitations: number;
      outbox: number;
      pending_seats: number;
    }>(`select
        (select count(*)::int from entitlement_commands
          where command_id=$1) commands,
        (select count(*)::int from access_decision_audit
          where command_id=$1) decisions,
        (select count(*)::int from audit_events
          where target_id=$1::text) audits,
        (select count(*)::int from outbox_events
          where event_id=$1) outbox,
        (select count(*)::int from seat_invitations
          where normalized_email='atomic-rollback@example.test') invitations,
        (select count(*)::int from seat_reservations
          where account_id=$2 and state='pending') pending_seats`,
    [commandId, accountA])).rows[0]).toEqual({
      audits: 0,
      commands: 0,
      decisions: 0,
      invitations: 0,
      outbox: 0,
      pending_seats: 0,
    });
  });

  it("fulfills complete isolated product bundles and keeps one persistent Club source", async () => {
    await seedAccount(accountA, false);
    const academy = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        commandId: randomUUID(),
        offerCode: "self_paced",
        sourceId: "pi_academy_fulfillment",
        sourceKind: "purchase",
        startsAt: new Date("2024-02-29T09:30:00.123Z"),
      })));
    expect(academy.supportEndsAt).toEqual(new Date("2025-02-28T09:30:00.123Z"));
    const businessOs = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        commandId: randomUUID(), offerCode: "business_os",
        sourceId: "sub_business_os", sourceKind: "subscription",
        startsAt: now, endsAt: new Date("2026-09-13T12:00:00.123Z"),
      })));
    const clubStart = now;
    const clubEnd = new Date("2026-09-28T12:00:00.123Z");
    const club = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: academy.sourceRegistryId,
        commandId: randomUUID(), endsAt: clubEnd,
        offerCode: "operator_club_monthly", sourceId: "sub_club",
        sourceKind: "subscription", startsAt: clubStart,
      })));
    expect(businessOs.sourceRegistryId).not.toBe(club.sourceRegistryId);
    const duplicateClub = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        academySourceRegistryId: academy.sourceRegistryId,
        commandId: randomUUID(), endsAt: clubEnd,
        offerCode: "operator_club_annual", sourceId: "sub_club_replacement",
        sourceKind: "subscription", startsAt: clubStart,
      }));
    expect(duplicateClub).toMatchObject({
      status: "applied",
      value: { fulfillmentStatus: "reconciliation",
        reconciliationKind: "parked_receipt" },
    });
    const rows = await harness.database.pool.query<{
      capability: string; source_registry_id: string;
    }>("select capability,source_registry_id from entitlement_grants order by source_registry_id,capability");
    expect(rows.rows.filter((row) => row.source_registry_id === academy.sourceRegistryId))
      .toHaveLength(3);
    expect(rows.rows.filter((row) => row.source_registry_id === club.sourceRegistryId))
      .toHaveLength(3);
    expect(rows.rows.filter((row) => row.source_registry_id === businessOs.sourceRegistryId))
      .toEqual([{ capability: "business_os", source_registry_id: businessOs.sourceRegistryId }]);
  });

  it("starts Club at the later of included-support end and fulfillment time", async () => {
    await seedAccount(accountA);
    const futureAcademy = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "self_paced", sourceId: "academy-future-handoff",
        sourceKind: "purchase", startsAt: now })));
    const futureEnd = new Date(futureAcademy.supportEndsAt!.getTime() + 86_400_000);
    const scheduled = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        academySourceRegistryId: futureAcademy.sourceRegistryId,
        offerCode: "operator_club_monthly", sourceId: "club-future-handoff",
        sourceKind: "subscription", startsAt: futureAcademy.supportEndsAt!,
        endsAt: futureEnd })));
    expect((await harness.database.pool.query<{ starts_at: Date }>(
      "select min(starts_at) starts_at from entitlement_grants where source_registry_id=$1",
      [scheduled.sourceRegistryId],
    )).rows[0]?.starts_at).toEqual(futureAcademy.supportEndsAt);

    await seedAccount(accountB);
    const oldStart = new Date("2024-01-01T00:00:00.000Z");
    const oldAcademy = applied(await systemUnitOfWork(accountB).transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "self_paced", sourceId: "academy-expired-handoff",
        sourceKind: "purchase", startsAt: oldStart })));
    const backdated = reconciled(await systemUnitOfWork(accountB).transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        academySourceRegistryId: oldAcademy.sourceRegistryId,
        offerCode: "operator_club_monthly", sourceId: "club-backdated-invalid",
        sourceKind: "subscription", startsAt: oldAcademy.supportEndsAt!,
        endsAt: new Date(now.getTime() + 86_400_000) })));
    expect(backdated).toMatchObject({
      fulfillmentStatus: "reconciliation", reasonCode: "CLUB_ACADEMY_PAIR_REQUIRED",
    });
    const immediate = applied(await systemUnitOfWork(accountB).transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        academySourceRegistryId: oldAcademy.sourceRegistryId,
        offerCode: "operator_club_monthly", sourceId: "club-immediate-handoff",
        sourceKind: "subscription", startsAt: now,
        endsAt: new Date(now.getTime() + 86_400_000) })));
    expect((await harness.database.pool.query<{ starts_at: Date }>(
      "select starts_at from entitlement_grants where source_registry_id=$1 limit 1",
      [immediate.sourceRegistryId],
    )).rows[0]?.starts_at).toEqual(now);
  });

  it("requires the exact paired Academy purchase to be effective before Club", async () => {
    await seedAccount(accountA);
    const academyStart = new Date(now.getTime() + 1);
    const academy = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "self_paced", sourceId: "academy-future-club-parent",
        sourceKind: "purchase", startsAt: academyStart })));
    const reconciliationId = randomUUID();
    const parked = reconciled(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: reconciliationId,
        academySourceRegistryId: academy.sourceRegistryId,
        offerCode: "operator_club_monthly", sourceId: "club-before-academy",
        sourceKind: "subscription", startsAt: academy.supportEndsAt!,
        endsAt: new Date(academy.supportEndsAt!.getTime() + 86_400_000) })));
    expect(parked).toMatchObject({
      fulfillmentStatus: "reconciliation",
      reasonCode: "CLUB_ACADEMY_PAIR_REQUIRED",
      reconciliationId: expect.any(String),
    });
    expect(await commandEvidence(harness.database, reconciliationId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    const atBoundary = applied(await systemUnitOfWork(accountA, randomUUID(), academyStart)
      .transaction((tx) => tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        academySourceRegistryId: academy.sourceRegistryId,
        offerCode: "operator_club_monthly", sourceId: "club-at-academy-start",
        sourceKind: "subscription", startsAt: academy.supportEndsAt!,
        endsAt: new Date(academy.supportEndsAt!.getTime() + 86_400_000) })));
    expect(atBoundary.sourceRegistryId).toEqual(expect.any(String));
  });

  it("redeems once, replays from post-state, and expires then reinvites as new history", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const oldToken = Buffer.alloc(32, 31);
    const invitation = applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        email: "claim@example.test", tokenHash: oldToken,
      })));
    const redeemId = randomUUID();
    const redeemInput = {
      clerkUserId: "claimed-teammate", commandId: redeemId,
      email: "claim@example.test", tokenHash: oldToken,
    };
    const first = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.redeemInvitation(redeemInput));
    const replay = await systemUnitOfWork(accountA, randomUUID(), new Date(now.getTime() + 1))
      .transaction((tx) => tx.entitlements.redeemInvitation(redeemInput));
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await commandEvidence(harness.database, redeemId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });

    applied(await ownerUnitOfWork().transaction((tx) => tx.entitlements.revokeSeat({
      commandId: randomUUID(), reservationId: applied(first).reservationId,
      reason: "Teammate access revoked after invitation redemption",
    })));
    await expect(systemUnitOfWork(accountA, randomUUID(), new Date(now.getTime() + 2))
      .transaction((tx) => tx.entitlements.redeemInvitation(redeemInput)))
      .rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "42501");
    expect(await commandEvidence(harness.database, redeemId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });

    const secondToken = Buffer.alloc(32, 32);
    const oldStart = new Date(now.getTime() - 169 * 3_600_000);
    const expiredInvitation = applied(await ownerUnitOfWork(randomUUID(), oldStart)
      .transaction((tx) => tx.entitlements.reservePendingSeat({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        email: "expired@example.test", tokenHash: secondToken,
      })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.expireInvitation({
        commandId: randomUUID(), invitationId: expiredInvitation.invitationId,
      })));
    const reinvited = applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        email: "expired@example.test", tokenHash: Buffer.alloc(32, 33),
      })));
    expect(reinvited.invitationId).not.toBe(expiredInvitation.invitationId);
    const history = await harness.database.pool.query<{ state: string }>(
      "select state from seat_reservations where invitation_id=any($1::uuid[]) order by created_at",
      [[expiredInvitation.invitationId, reinvited.invitationId]],
    );
    expect(history.rows.map(({ state }) => state)).toEqual(["expired", "pending"]);
    expect(invitation.slot).toBe(2);
  });

  it("converges concurrent cross-account invitation redemption for one Clerk subject", async () => {
    await seedAccount(accountA);
    await seedAccount(accountB);
    const academyA = applied(await systemUnitOfWork(accountA).transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "self_paced", sourceId: "race-academy-a",
        sourceKind: "purchase", startsAt: now })));
    const academyB = applied(await systemUnitOfWork(accountB).transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "self_paced", sourceId: "race-academy-b",
        sourceKind: "purchase", startsAt: now })));
    const membershipBRow = await harness.database.pool.query<{
      identity_id: string; membership_id: string;
    }>(`select i.id identity_id,m.id membership_id from memberships m
        join member_identities i on i.id=m.member_identity_id
        where m.account_id=$1 and m.role='owner' and m.status='active'`, [accountB]);
    const ownerB = createUnitOfWork(member.database, {
      accountId: accountB,
      actor: trustedMemberActor({ kind: "member",
        actorId: membershipBRow.rows[0]!.identity_id, accountId: accountB,
        clerkUserId: `user_${accountB}`,
        membershipId: membershipBRow.rows[0]!.membership_id,
        role: "owner", authenticatedAt: now }),
      correlationId: randomUUID(), clock: { now: () => now },
    });
    const tokenA = Buffer.alloc(32, 81);
    const tokenB = Buffer.alloc(32, 82);
    applied(await ownerUnitOfWork().transaction((tx) => tx.entitlements.reservePendingSeat({
      commandId: randomUUID(), sourceRegistryId: academyA.sourceRegistryId,
      email: "shared-redeem@example.test", tokenHash: tokenA,
    })));
    applied(await ownerB.transaction((tx) => tx.entitlements.reservePendingSeat({
      commandId: randomUUID(), sourceRegistryId: academyB.sourceRegistryId,
      email: "shared-redeem@example.test", tokenHash: tokenB,
    })));
    const commandA = randomUUID();
    const commandB = randomUUID();
    const blocker = await harness.database.pool.connect();
    await harness.database.pool.query(`
      create function syntholo_test_redeem_barrier() returns trigger
      language plpgsql set search_path=pg_catalog as $fn$
      begin
        perform pg_advisory_xact_lock(hashtextextended('task8-redeem-race',0));
        return new;
      end $fn$;
      revoke all on function syntholo_test_redeem_barrier() from public;
      create trigger syntholo_test_redeem_barrier before insert on member_identities
        for each row when (new.provider_user_id='shared-redeem-subject')
        execute function syntholo_test_redeem_barrier()
    `);
    await blocker.query(
      "select pg_advisory_lock(hashtextextended('task8-redeem-race',0))",
    );
    const pendingA = systemUnitOfWork(accountA).transaction((tx) =>
      tx.entitlements.redeemInvitation({
        commandId: commandA, tokenHash: tokenA, clerkUserId: "shared-redeem-subject",
        email: "shared-redeem@example.test",
      }));
    const pendingB = systemUnitOfWork(accountB).transaction((tx) =>
      tx.entitlements.redeemInvitation({
        commandId: commandB, tokenHash: tokenB, clerkUserId: "shared-redeem-subject",
        email: "shared-redeem@example.test",
      }));
    await waitForAdvisoryKeyWaiters(harness.database, "task8-redeem-race", 2);
    await blocker.query(
      "select pg_advisory_unlock(hashtextextended('task8-redeem-race',0))",
    );
    const [redeemA, redeemB] = await Promise.all([pendingA, pendingB]);
    blocker.release();
    await harness.database.pool.query(`
      drop trigger syntholo_test_redeem_barrier on member_identities;
      drop function syntholo_test_redeem_barrier()
    `);
    expect([redeemA.status, redeemB.status].sort()).toEqual(["applied", "denied"]);
    expect([redeemA, redeemB].find(({ status }) => status === "denied"))
      .toMatchObject({ code: "IDENTITY_ACCOUNT_CONFLICT" });
    expect(await commandEvidence(harness.database, commandA)).toEqual({
      decisions: 1, audits: 1, outbox: redeemA.status === "applied" ? 1 : 0,
    });
    expect(await commandEvidence(harness.database, commandB)).toEqual({
      decisions: 1, audits: 1, outbox: redeemB.status === "applied" ? 1 : 0,
    });
    const redemptionState = await harness.database.pool.query<{
      account_id: string;
      consumed: boolean;
      state: string;
    }>(`select t.account_id,t.consumed_at is not null consumed,r.state
        from seat_invitation_token_generations t
        join seat_reservations r on r.invitation_id=t.invitation_id
          and r.account_id=t.account_id
        where t.token_hash=any($1::bytea[]) order by t.account_id`,
    [[tokenA, tokenB]]);
    const winnerAccount = redeemA.status === "applied" ? accountA : accountB;
    expect(redemptionState.rows).toEqual([
      { account_id: accountA, consumed: winnerAccount === accountA,
        state: winnerAccount === accountA ? "active" : "pending" },
      { account_id: accountB, consumed: winnerAccount === accountB,
        state: winnerAccount === accountB ? "active" : "pending" },
    ]);
    expect((await harness.database.pool.query<{ account_id: string }>(
      `select account_id from member_identities
       where provider='clerk' and provider_user_id='shared-redeem-subject'`,
    )).rows).toEqual([{ account_id: winnerAccount }]);
  });

  it("replaces a teammate with recent auth and transfers ownership while seats stay", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const token = Buffer.alloc(32, 41);
    applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: sourceA, email: "team@example.test", tokenHash: token })));
    const teammate = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.redeemInvitation({ commandId: randomUUID(), tokenHash: token,
        clerkUserId: "team-user", email: "team@example.test" })));
    const transferId = randomUUID();
    const transferInput = { commandId: transferId,
      reason: "New operating owner", targetMembershipId: teammate.membershipId };
    const exactBoundaryOwner = createUnitOfWork(member.database, {
      accountId: accountA,
      actor: trustedMemberActor({ kind: "member", actorId: identityA, accountId: accountA,
        clerkUserId: `user_${accountA}`, membershipId: membershipA,
        role: "owner", authenticatedAt: new Date(now.getTime() - 300_000) }),
      correlationId: randomUUID(), clock: { now: () => now },
    });
    const firstTransfer = await exactBoundaryOwner.transaction((tx) =>
      tx.entitlements.transferOwnership(transferInput));
    const formerOwner = createUnitOfWork(member.database, {
      accountId: accountA,
      actor: trustedMemberActor({ kind: "member", actorId: identityA, accountId: accountA,
        clerkUserId: `user_${accountA}`, membershipId: membershipA,
        role: "teammate", authenticatedAt: now }),
      correlationId: randomUUID(), clock: { now: () => new Date(now.getTime() + 1) },
    });
    const transferReplay = await formerOwner.transaction((tx) =>
      tx.entitlements.transferOwnership(transferInput));
    expect(transferReplay).toEqual({ ...firstTransfer, replayed: true });
    const teammateDeniedId = randomUUID();
    const teammateDenied = await createUnitOfWork(member.database, {
      accountId: accountA,
      actor: trustedMemberActor({ kind: "member", actorId: identityA, accountId: accountA,
        clerkUserId: `user_${accountA}`, membershipId: membershipA,
        role: "teammate", authenticatedAt: now }),
      correlationId: randomUUID(), clock: { now: () => now },
    }).transaction((tx) => tx.entitlements.transferOwnership({
      commandId: teammateDeniedId, reason: "Cannot self-promote",
      targetMembershipId: teammate.membershipId,
    }));
    expect(teammateDenied).toMatchObject({ status: "denied", code: "OWNER_REQUIRED" });
    expect(await commandEvidence(harness.database, teammateDeniedId))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    const ownerOnlyAttempts = [
      (commandId: string) => formerOwner.transaction((tx) =>
        tx.entitlements.reservePendingSeat({ commandId, sourceRegistryId: sourceA,
          email: "former-owner-invite@example.test", tokenHash: Buffer.alloc(32, 93) })),
      (commandId: string) => formerOwner.transaction((tx) =>
        tx.entitlements.resendInvitation({ commandId, invitationId: randomUUID(),
          tokenHash: Buffer.alloc(32, 94) })),
      (commandId: string) => formerOwner.transaction((tx) =>
        tx.entitlements.revokeSeat({ commandId, reservationId: randomUUID(),
          reason: "Former owner cannot revoke" })),
      (commandId: string) => formerOwner.transaction((tx) =>
        tx.entitlements.replaceSeat({ commandId,
          targetMembershipId: teammate.membershipId,
          email: "former-owner-replace@example.test", tokenHash: Buffer.alloc(32, 95),
          reason: "Former owner cannot replace" })),
    ];
    for (const attempt of ownerOnlyAttempts) {
      const commandId = randomUUID();
      await expect(attempt(commandId)).resolves.toMatchObject({
        status: "denied", code: "OWNER_REQUIRED",
      });
      expect(await commandEvidence(harness.database, commandId))
        .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    }
    const transferred = await harness.database.pool.query<{
      id: string; role: string; seat: number;
    }>(`select m.id,m.role,r.slot seat from memberships m
        join seat_reservations r on r.membership_id=m.id and r.state='active'
        where m.account_id=$1 order by r.slot`, [accountA]);
    expect(transferred.rows).toEqual([
      { id: membershipA, role: "teammate", seat: 1 },
      { id: teammate.membershipId, role: "owner", seat: 2 },
    ]);

    const newOwnerIdentity = (await harness.database.pool.query<{ member_identity_id: string }>(
      "select member_identity_id from memberships where id=$1", [teammate.membershipId],
    )).rows[0]!.member_identity_id;
    const staleReplacementId = randomUUID();
    const staleActor = trustedMemberActor({ kind: "member",
      actorId: newOwnerIdentity, accountId: accountA,
      clerkUserId: "team-user", membershipId: teammate.membershipId,
      role: "owner", authenticatedAt: new Date(now.getTime() - 300_001) });
    staleActor.authenticatedAt.setTime(now.getTime());
    const staleOwner = createUnitOfWork(member.database, {
      accountId: accountA,
      actor: staleActor,
      correlationId: randomUUID(), clock: { now: () => now },
    });
    const staleReplacement = await staleOwner.transaction((tx) =>
      tx.entitlements.replaceSeat({ commandId: staleReplacementId,
        email: "replacement@example.test", reason: "Teammate changed",
        targetMembershipId: membershipA, tokenHash: Buffer.alloc(32, 42) }));
    expect(staleReplacement).toMatchObject({
      status: "denied", code: "RECENT_AUTH_REQUIRED",
    });
    expect(await commandEvidence(harness.database, staleReplacementId))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });

    const exactBoundaryNewOwner = createUnitOfWork(member.database, {
      accountId: accountA,
      actor: trustedMemberActor({ kind: "member", actorId: newOwnerIdentity, accountId: accountA,
        clerkUserId: "team-user", membershipId: teammate.membershipId,
        role: "owner", authenticatedAt: new Date(now.getTime() - 300_000) }),
      correlationId: randomUUID(), clock: { now: () => now },
    });
    const replaceId = randomUUID();
    const replaced = applied(await exactBoundaryNewOwner.transaction((tx) =>
      tx.entitlements.replaceSeat({ commandId: replaceId,
        email: "replacement@example.test", reason: "Teammate changed",
        targetMembershipId: membershipA,
        tokenHash: Buffer.alloc(32, 42) })));
    expect(replaced.slot).toBe(1);
    const reasonAudit = await harness.database.pool.query<{ operator_reason: string }>(
      `select payload->>'operatorReason' operator_reason from audit_events
       where target_id=$1`, [replaceId],
    );
    expect(reasonAudit.rows[0]?.operator_reason).toBe("Teammate changed");
  });

  it("serializes competing ownership transfers and transfer-first member revocation", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const redeemTeammate = async (
      tokenByte: number,
      clerkUserId: string,
      email: string,
    ) => {
      const tokenHash = Buffer.alloc(32, tokenByte);
      applied(await ownerUnitOfWork().transaction((tx) =>
        tx.entitlements.reservePendingSeat({
          commandId: randomUUID(), sourceRegistryId: sourceA, email, tokenHash,
        })));
      return applied(await systemUnitOfWork().transaction((tx) =>
        tx.entitlements.redeemInvitation({
          commandId: randomUUID(), tokenHash, clerkUserId, email,
        })));
    };
    const teammateOne = await redeemTeammate(
      141, "transfer-race-one", "transfer-race-one@example.test",
    );
    const teammateTwo = await redeemTeammate(
      142, "transfer-race-two", "transfer-race-two@example.test",
    );
    const accountLockKey = `syntholo-entitlement-account:${accountA}`;
    const firstBlocker = await harness.database.pool.connect();
    await firstBlocker.query(
      "select pg_advisory_lock(hashtextextended($1,0))",
      [accountLockKey],
    );
    const firstCommand = randomUUID();
    const secondCommand = randomUUID();
    const firstTransfer = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.transferOwnership({
        commandId: firstCommand,
        targetMembershipId: teammateOne.membershipId,
        reason: "First contender was selected as the next owner",
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 1);
    const secondTransfer = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.transferOwnership({
        commandId: secondCommand,
        targetMembershipId: teammateTwo.membershipId,
        reason: "Second contender raced the ownership transfer",
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 2);
    await firstBlocker.query(
      "select pg_advisory_unlock(hashtextextended($1,0))",
      [accountLockKey],
    );
    firstBlocker.release();
    expect((await firstTransfer).status).toBe("applied");
    expect(await secondTransfer).toMatchObject({
      status: "denied", code: "OWNER_REQUIRED",
    });
    expect(await commandEvidence(harness.database, firstCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect(await commandEvidence(harness.database, secondCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    expect((await harness.database.pool.query<{ id: string }>(
      `select id from memberships
       where account_id=$1 and role='owner' and status='active'`, [accountA],
    )).rows).toEqual([{ id: teammateOne.membershipId }]);

    const teammateOneOwner = createUnitOfWork(member.database, {
      accountId: accountA,
      actor: trustedMemberActor({
        kind: "member", actorId: teammateOne.identityId, accountId: accountA,
        clerkUserId: "transfer-race-one", membershipId: teammateOne.membershipId,
        role: "owner", authenticatedAt: now,
      }),
      correlationId: randomUUID(), clock: { now: () => now },
    });
    const secondBlocker = await harness.database.pool.connect();
    await secondBlocker.query(
      "select pg_advisory_lock(hashtextextended($1,0))",
      [accountLockKey],
    );
    const transferFirstCommand = randomUUID();
    const revokeSecondCommand = randomUUID();
    const transferFirst = teammateOneOwner.transaction((tx) =>
      tx.entitlements.transferOwnership({
        commandId: transferFirstCommand,
        targetMembershipId: membershipA,
        reason: "Original owner resumed ownership before staff revocation",
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 1);
    const revokeSecond = staffUnitOfWork().transaction((tx) =>
      tx.entitlements.revokeMember({
        commandId: revokeSecondCommand,
        membershipId: membershipA,
        reason: "Staff revocation serialized after the ownership transfer",
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 2);
    await secondBlocker.query(
      "select pg_advisory_unlock(hashtextextended($1,0))",
      [accountLockKey],
    );
    secondBlocker.release();
    expect((await transferFirst).status).toBe("applied");
    expect(await revokeSecond).toMatchObject({
      status: "denied", code: "ACTIVE_TEAMMATE_REQUIRED",
    });
    expect(await commandEvidence(harness.database, transferFirstCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect(await commandEvidence(harness.database, revokeSecondCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    expect((await harness.database.pool.query<{ id: string }>(
      `select id from memberships
       where account_id=$1 and role='owner' and status='active'`, [accountA],
    )).rows).toEqual([{ id: membershipA }]);
  });

  it("serializes mixed claim refund invite transfer and suspension without deadlock", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const teammateToken = Buffer.alloc(32, 143);
    applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: randomUUID(), sourceRegistryId: sourceA,
        email: "mixed-stress-teammate@example.test", tokenHash: teammateToken,
      })));
    const teammate = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.redeemInvitation({
        commandId: randomUUID(), tokenHash: teammateToken,
        clerkUserId: "mixed-stress-teammate",
        email: "mixed-stress-teammate@example.test",
      })));
    const accountLockKey = `syntholo-entitlement-account:${accountA}`;
    const blocker = await harness.database.pool.connect();
    await blocker.query(
      "select pg_advisory_lock(hashtextextended($1,0))",
      [accountLockKey],
    );
    const commands = {
      claim: randomUUID(), refund: randomUUID(), invite: randomUUID(),
      transfer: randomUUID(), suspend: randomUUID(),
    };
    const claimPending = systemUnitOfWork().transaction((tx) =>
      tx.entitlements.establishOwner({
        commandId: commands.claim, clerkUserId: "mixed-stress-owner",
        email: "mixed-stress-owner@example.test",
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 1);
    const refundPending = systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({
        commandId: commands.refund, sourceRegistryId: sourceA,
        reason: "Mixed stress refund was authorized",
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 2);
    const invitePending = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({
        commandId: commands.invite, sourceRegistryId: sourceA,
        email: "mixed-stress-invite@example.test", tokenHash: Buffer.alloc(32, 144),
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 3);
    const transferPending = ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.transferOwnership({
        commandId: commands.transfer, targetMembershipId: teammate.membershipId,
        reason: "Mixed stress ownership transfer",
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 4);
    const suspendPending = staffUnitOfWork().transaction((tx) =>
      tx.entitlements.suspendAccount({
        commandId: commands.suspend,
        reason: "Mixed stress suspension finalized the serialized state",
      }));
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 5);
    await blocker.query(
      "select pg_advisory_unlock(hashtextextended($1,0))",
      [accountLockKey],
    );
    blocker.release();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const results = await Promise.race([
      Promise.all([
        claimPending, refundPending, invitePending, transferPending, suspendPending,
      ]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("MIXED_STRESS_TIMEOUT")), 10_000);
      }),
    ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    expect(results).toEqual([
      { status: "denied", code: "OWNER_EXISTS", replayed: false },
      expect.objectContaining({ status: "applied", replayed: false }),
      { status: "denied", code: "ACADEMY_SOURCE_REQUIRED", replayed: false },
      { status: "denied", code: "ACTIVE_TEAMMATE_REQUIRED", replayed: false },
      expect.objectContaining({ status: "applied", replayed: false }),
    ]);
    for (const [commandId, outbox] of [
      [commands.claim, 0], [commands.refund, 1], [commands.invite, 0],
      [commands.transfer, 0], [commands.suspend, 1],
    ] as const) {
      expect(await commandEvidence(harness.database, commandId))
        .toEqual({ decisions: 1, audits: 1, outbox });
    }
    expect((await harness.database.pool.query<{
      account_status: string; active_owners: number; occupied_seats: number;
      live_grants: number;
    }>(`select
        (select status from accounts where id=$1) account_status,
        (select count(*)::int from memberships where account_id=$1
          and role='owner' and status='active') active_owners,
        (select count(*)::int from seat_reservations where account_id=$1
          and state in ('active','pending')) occupied_seats,
        (select count(*)::int from entitlement_grants where account_id=$1
          and status in ('active','grace')) live_grants`, [accountA])).rows[0])
      .toEqual({ account_status: "suspended", active_owners: 1,
        occupied_seats: 0, live_grants: 0 });
  }, 20_000);

  it("refunds only the selected product and preserves identity and achievement-owned data", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    await seedOwnerSeat(harness.database);
    const oldSeatId = (await harness.database.pool.query<{ id: string }>(
      "select id from seat_reservations where membership_id=$1 and state='active'",
      [membershipA],
    )).rows[0]!.id;
    const business = randomUUID();
    await inTransaction(harness.database.pool, async (client) => {
      await client.query(`insert into entitlement_sources
        (id,account_id,source_kind,source_id,offer_code,provenance,created_at)
        values($1,$2,'subscription','business-refund-isolation','business_os','test',$3)`,
      [business, accountA, now]);
      await client.query(`insert into entitlement_grants
        (account_id,source_registry_id,source_kind,source_id,offer_code,capability,
         status,starts_at,ends_at,provenance,created_at,updated_at)
        values($1,$2,'subscription','business-refund-isolation','business_os','business_os',
          'active',$3,$4,'test',$3,$3)`,
      [accountA, business, now, new Date(now.getTime() + 86_400_000)]);
    });
    const commandId = randomUUID();
    applied(await systemUnitOfWork().transaction((tx) => tx.entitlements.refundProduct({
      commandId, reason: "Approved seven-day refund", sourceRegistryId: sourceA,
    })));
    const state = await harness.database.pool.query<{
      capability: string; status: string;
    }>("select capability,status from entitlement_grants order by capability");
    expect(state.rows).toContainEqual({ capability: "business_os", status: "active" });
    expect(state.rows.filter(({ capability }) => capability !== "business_os")
      .every(({ status }) => status === "refunded")).toBe(true);
    expect(await commandEvidence(harness.database, commandId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    const refundAudit = await harness.database.pool.query<{ operator_reason: string }>(
      `select payload->>'operatorReason' operator_reason from audit_events
       where target_id=$1`, [commandId],
    );
    expect(refundAudit.rows[0]?.operator_reason).toBe("Approved seven-day refund");
    expect((await harness.database.pool.query(
      "select status from memberships where id=$1", [membershipA],
    )).rows[0]?.status).toBe("active");

    const repurchase = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "self_paced", sourceId: "purchase-academy-repurchase",
        sourceKind: "purchase", startsAt: new Date(now.getTime() + 1) })));
    const reseated = await harness.database.pool.query<{
      id: string; source_registry_id: string; state: string;
    }>("select id,source_registry_id,state from seat_reservations where membership_id=$1 order by created_at",
    [membershipA]);
    expect(reseated.rows).toEqual([
      { id: oldSeatId, source_registry_id: sourceA, state: "revoked" },
      { id: expect.any(String), source_registry_id: repurchase.sourceRegistryId, state: "active" },
    ]);
    const firstInvite = await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: repurchase.sourceRegistryId,
        email: "repurchase-one@example.test", tokenHash: Buffer.alloc(32, 61) }));
    const secondInvite = await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: repurchase.sourceRegistryId,
        email: "repurchase-two@example.test", tokenHash: Buffer.alloc(32, 62) }));
    expect([firstInvite.status, secondInvite.status]).toEqual(["applied", "applied"]);
    const occupied = await harness.database.pool.query<{ count: number }>(
      `select count(*)::int count from seat_reservations where account_id=$1
       and state in ('active','pending')`, [accountA],
    );
    expect(occupied.rows[0]?.count).toBe(3);
  });

  it("reactivates the same inactive teammate identity after refund and repurchase", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const oldToken = Buffer.alloc(32, 63);
    applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: sourceA, email: "returning@example.test",
        tokenHash: oldToken })));
    const original = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.redeemInvitation({ commandId: randomUUID(), tokenHash: oldToken,
        clerkUserId: "returning-clerk-user", email: "returning@example.test" })));
    const oldSeat = original.reservationId;
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.refundProduct({ commandId: randomUUID(),
        sourceRegistryId: sourceA, reason: "Approved refund" })));
    expect((await harness.database.pool.query<{ status: string }>(
      "select status from memberships where id=$1", [original.membershipId],
    )).rows[0]?.status).toBe("revoked");
    const repurchaseAt = new Date(now.getTime() + 1);
    const repurchase = applied(await systemUnitOfWork(accountA, randomUUID(), repurchaseAt)
      .transaction((tx) => tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "self_paced", sourceId: "academy-returning-repurchase",
        sourceKind: "purchase", startsAt: repurchaseAt })));
    const newToken = Buffer.alloc(32, 64);
    applied(await ownerUnitOfWork(randomUUID(), repurchaseAt).transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: repurchase.sourceRegistryId,
        email: "returning@example.test", tokenHash: newToken })));
    const returned = applied(await systemUnitOfWork(accountA, randomUUID(), repurchaseAt)
      .transaction((tx) => tx.entitlements.redeemInvitation({
        commandId: randomUUID(), tokenHash: newToken,
        clerkUserId: "returning-clerk-user", email: "returning@example.test",
      })));
    expect(returned.identityId).toBe(original.identityId);
    expect(returned.membershipId).toBe(original.membershipId);
    expect(returned.reservationId).not.toBe(oldSeat);
    const seats = await harness.database.pool.query<{ id: string; state: string }>(
      "select id,state from seat_reservations where membership_id=$1 order by created_at",
      [original.membershipId],
    );
    expect(seats.rows).toEqual([
      { id: oldSeat, state: "revoked" },
      { id: returned.reservationId, state: "active" },
    ]);
  });

  it("releases only one dispute source and preserves overlapping restrictions", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const first = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({ commandId: randomUUID(), disputeId: "dp_first",
        targetSourceRegistryId: sourceA })));
    const second = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({ commandId: randomUUID(), disputeId: "dp_second",
        targetSourceRegistryId: sourceA })));
    const nullResolutionId = randomUUID();
    await expect(harness.database.pool.query(
      `select * from syntholo_resolve_dispute($1,$2,$3,$4,null,$5)`,
      [accountA, nullResolutionId, "b".repeat(64), first.holdSourceRegistryId, now],
    )).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "22023");
    expect((await harness.database.pool.query<{ count: number }>(
      "select count(*)::int count from account_holds where source_registry_id=$1 and released_at is null",
      [first.holdSourceRegistryId],
    )).rows[0]?.count).toBe(3);
    expect(await commandEvidence(harness.database, nullResolutionId))
      .toEqual({ decisions: 0, audits: 0, outbox: 0 });
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({ commandId: randomUUID(),
        holdSourceRegistryId: first.holdSourceRegistryId, resolution: "won" })));
    const remaining = await harness.database.pool.query<{ source_registry_id: string }>(
      "select source_registry_id from account_holds where released_at is null order by source_registry_id",
    );
    expect(new Set(remaining.rows.map(({ source_registry_id }) => source_registry_id)))
      .toEqual(new Set([second.holdSourceRegistryId]));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({ commandId: randomUUID(),
        holdSourceRegistryId: second.holdSourceRegistryId, resolution: "lost" })));
    expect((await harness.database.pool.query<{ status: string }>(
      "select distinct status from entitlement_grants where source_registry_id=$1", [sourceA],
    )).rows).toEqual([{ status: "revoked" }]);
    const remainingLost = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({ commandId: randomUUID(), disputeId: "dp_third",
        targetSourceRegistryId: sourceA })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({ commandId: randomUUID(),
        holdSourceRegistryId: remainingLost.holdSourceRegistryId, resolution: "lost" })));
    expect((await harness.database.pool.query<{ count: number }>(
      "select count(*)::int count from account_holds where released_at is null",
    )).rows[0]?.count).toBe(0);
  });

  it("queues reuse of one dispute id for a different commercial target", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const setup = recordedSetup(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recordBusinessOsSetupPurchase({ commandId: randomUUID(),
        sourceId: "setup-dispute-target", purchasedAt: now })));
    const first = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({ commandId: randomUUID(),
        disputeId: "dp_exact_target", targetSourceRegistryId: sourceA })));
    const conflictCommand = randomUUID();
    const conflict = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({ commandId: conflictCommand,
        disputeId: "dp_exact_target",
        targetSourceRegistryId: setup.sourceRegistryId }));
    expect(conflict).toMatchObject({ status: "applied", value: {
      disputeStatus: "reconciliation",
      reconciliationId: expect.any(String),
      holdSourceRegistryId: null,
    } });
    if (conflict.status !== "applied"
      || conflict.value.disputeStatus !== "reconciliation") {
      throw new Error("EXPECTED_DISPUTE_RECONCILIATION");
    }
    expect(await commandEvidence(harness.database, conflictCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect((await harness.database.pool.query<{
      sources: number; holds: number; incident_status: string; event_type: string;
    }>(
      `select (select count(*)::int from account_hold_sources
          where source_kind='stripe_dispute' and source_id='dp_exact_target') sources,
        (select count(*)::int from account_holds
          where source_registry_id=$1 and released_at is null) holds,
        (select status from commerce_reconciliations where id=$2) incident_status,
        (select type from outbox_events where event_id=$3) event_type`,
      [first.holdSourceRegistryId, conflict.value.reconciliationId, conflictCommand],
    )).rows[0]).toEqual({
      sources: 1,
      holds: 3,
      incident_status: "open",
      event_type: "entitlements.reconciliation_required.v1",
    });
  });

  it("queues a first dispute event mapped to another account without leaking evidence", async () => {
    await seedAccount(accountA);
    await seedAccount(accountB);
    await seedAcademyBundle(harness.database, accountB);
    const commandId = randomUUID();
    const conflict = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({
        commandId,
        disputeId: "dp_cross_account_target",
        targetSourceRegistryId: sourceA,
      }));
    expect(conflict).toMatchObject({ status: "applied", value: {
      disputeStatus: "reconciliation",
      reconciliationId: expect.any(String),
      holdSourceRegistryId: null,
    } });
    expect(await commandEvidence(harness.database, commandId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect((await harness.database.pool.query<{
      target_source_registry_id: string | null;
      source_id: string;
      evidence: string[];
    }>(`select r.target_source_registry_id,r.source_id,d.source_grant_ids evidence
        from commerce_reconciliations r
        join access_decision_audit d on d.command_id=$1
        where r.account_id=$2 and r.command_kind='open_dispute'`,
      [commandId, accountA])).rows).toEqual([{
      target_source_registry_id: null,
      source_id: "dp_cross_account_target",
      evidence: [],
    }]);
  });

  it("records held paid fulfillment for reconciliation and completes it only after release", async () => {
    await seedAccount(accountA);
    await seedAccount(accountB);
    await seedAcademyBundle(harness.database);
    const dispute = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({ commandId: randomUUID(),
        disputeId: "dp_commerce_block", targetSourceRegistryId: sourceA })));
    const reconciliationId = randomUUID();
    const reconciliation = reconciled(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: reconciliationId,
        offerCode: "business_os", sourceId: "bo_held", sourceKind: "subscription",
        startsAt: now, endsAt: new Date(now.getTime() + 86_400_000) })));
    expect(reconciliation.fulfillmentStatus).toBe("reconciliation");
    expect(await commandEvidence(harness.database, reconciliationId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect((await harness.database.pool.query<{ status: string; grants: number }>(
      `select r.status,(select count(*)::int from entitlement_grants g
         where g.source_registry_id=r.source_registry_id) grants
       from commerce_fulfillment_receipts r where r.source_registry_id=$1`,
      [reconciliation.sourceRegistryId],
    )).rows[0]).toEqual({ status: "reconciliation", grants: 0 });

    const heldReconcileId = randomUUID();
    expect(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.reconcileProductFulfillment({ commandId: heldReconcileId,
        sourceRegistryId: reconciliation.sourceRegistryId,
        reason: "Verified payment while dispute remains open" })))
      .toMatchObject({ status: "denied", code: "COMMERCE_HELD" });
    expect(await commandEvidence(harness.database, heldReconcileId))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveDispute({ commandId: randomUUID(),
        holdSourceRegistryId: dispute.holdSourceRegistryId, resolution: "won" })));
    expect(applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.reconcileProductFulfillment({ commandId: randomUUID(),
        sourceRegistryId: reconciliation.sourceRegistryId,
        reason: "Dispute was won and the paid subscription was verified" }))))
      .toEqual({ sourceRegistryId: reconciliation.sourceRegistryId,
        fulfillmentStatus: "fulfilled" });
    expect((await harness.database.pool.query<{ status: string; grants: number }>(
      `select r.status,(select count(*)::int from entitlement_grants g
         where g.source_registry_id=r.source_registry_id) grants
       from commerce_fulfillment_receipts r where r.source_registry_id=$1`,
      [reconciliation.sourceRegistryId],
    )).rows[0]).toEqual({ status: "fulfilled", grants: 1 });
    expect((await harness.database.pool.query<{ status: string }>(
      `select status from commerce_reconciliations where id=$1`,
      [reconciliation.reconciliationId],
    )).rows[0]?.status).toBe("resolved_fulfilled");
    expect((await harness.database.pool.query<{ type: string }>(
      "select type from outbox_events where event_id=$1", [reconciliationId],
    )).rows[0]?.type).toBe("entitlements.reconciliation_required.v1");

  });

  it("maps concurrent duplicate provider sources to reconciliation", async () => {
    await seedAccount(accountA);
    await seedAccount(accountB);
    const firstCommand = randomUUID();
    const conflictId = randomUUID();
    const blocker = await harness.database.pool.connect();
    await blocker.query(
      "select pg_advisory_lock(hashtextextended('subscription:bo_global_duplicate',0))",
    );
    const firstPending = systemUnitOfWork(accountA).transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: firstCommand,
        offerCode: "business_os", sourceId: "bo_global_duplicate",
        sourceKind: "subscription", startsAt: now,
        endsAt: new Date(now.getTime() + 86_400_000) }));
    const conflictPending = systemUnitOfWork(accountB).transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: conflictId,
        offerCode: "business_os", sourceId: "bo_global_duplicate",
        sourceKind: "subscription", startsAt: now,
        endsAt: new Date(now.getTime() + 86_400_000) }));
    await waitForAdvisoryKeyWaiters(
      harness.database,
      "subscription:bo_global_duplicate",
      2,
    );
    await blocker.query(
      "select pg_advisory_unlock(hashtextextended('subscription:bo_global_duplicate',0))",
    );
    blocker.release();
    const [first, conflict] = await Promise.all([firstPending, conflictPending]);
    expect(first.status).toBe("applied");
    expect(conflict.status).toBe("applied");
    if (first.status !== "applied" || conflict.status !== "applied") {
      throw new Error("EXPECTED_SERIALIZED_PROVIDER_RESULTS");
    }
    const values = [first.value, conflict.value];
    const fulfilled = values.find((value) => value.fulfillmentStatus === "fulfilled");
    const reconciliation = values.find(
      (value) => value.fulfillmentStatus === "reconciliation",
    );
    expect(fulfilled).toMatchObject({ fulfillmentStatus: "fulfilled" });
    expect(reconciliation).toMatchObject({
      fulfillmentStatus: "reconciliation",
      reconciliationKind: "provider_collision",
      reasonCode: "SOURCE_RECONCILIATION_REQUIRED",
      sourceRegistryId: null,
      reconciliationId: expect.any(String),
    });
    expect(await commandEvidence(harness.database, firstCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect(await commandEvidence(harness.database, conflictId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    const incidents = await harness.database.pool.query<{
      account_id: string;
      id: string;
      status: string;
      target_source_registry_id: string;
    }>(`select account_id,id,status,target_source_registry_id
        from commerce_reconciliations`);
    expect(incidents.rows).toEqual([{
      account_id: reconciliation?.reconciliationId === first.value.reconciliationId
        ? accountA : accountB,
      id: reconciliation?.reconciliationId,
      status: "open",
      target_source_registry_id: fulfilled?.sourceRegistryId,
    }]);
    const incidentId = reconciliation?.reconciliationId;
    if (incidentId === undefined) throw new Error("EXPECTED_RECONCILIATION_INCIDENT");
    const incidentAccount = incidents.rows[0]!.account_id;
    const open = await staffUnitOfWork(incidentAccount).transaction((tx) =>
      tx.entitlements.listCommerceReconciliations());
    expect(open).toEqual([expect.objectContaining({
      id: incidentId,
      reasonCode: "SOURCE_RECONCILIATION_REQUIRED",
      reviewDueAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      status: "open",
    })]);
    const claimId = randomUUID();
    expect(applied(await staffUnitOfWork(incidentAccount).transaction((tx) =>
      tx.entitlements.claimCommerceReconciliation({
        commandId: claimId,
        reconciliationId: incidentId,
      })))).toEqual({
      reconciliationId: incidentId,
      reviewDueAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      status: "claimed",
    });
    expect(await commandEvidence(harness.database, claimId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect((await harness.database.pool.query<{ type: string }>(
      "select type from outbox_events where event_id=$1", [claimId],
    )).rows[0]?.type).toBe("entitlements.command_applied.v1");
    const resolveId = randomUUID();
    expect(applied(await staffUnitOfWork(incidentAccount).transaction((tx) =>
      tx.entitlements.resolveCommerceReconciliation({
        commandId: resolveId,
        reconciliationId: incidentId,
        resolution: "manual",
        reason: "Provider account ownership conflict was handled manually",
      })))).toEqual({
      reconciliationId: incidentId,
      status: "resolved_manual",
    });
    expect(await staffUnitOfWork(incidentAccount).transaction((tx) =>
      tx.entitlements.listCommerceReconciliations())).toEqual([]);
    expect((await harness.database.pool.query<{ status: string }>(
      "select status from commerce_reconciliations where id=$1",
      [incidentId],
    )).rows[0]?.status).toBe("resolved_manual");
    expect(await commandEvidence(harness.database, resolveId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect((await harness.database.pool.query<{ type: string }>(
      "select type from outbox_events where event_id=$1", [resolveId],
    )).rows[0]?.type).toBe("entitlements.command_applied.v1");
    expect((await harness.database.pool.query<{ count: number }>(
      `select count(*)::int count from access_decision_audit d
       join entitlement_grants g on g.id=any(d.source_grant_ids)
       where d.command_id=$1 and g.account_id<>d.account_id`, [conflictId],
    )).rows[0]?.count).toBe(0);
  });

  it("parks one of two forced same-account Academy payments", async () => {
    await seedAccount(accountA);
    const accountLockKey = `syntholo-entitlement-account:${accountA}`;
    const blocker = await harness.database.pool.connect();
    await blocker.query(
      "select pg_advisory_lock(hashtextextended($1,0))",
      [accountLockKey],
    );
    const firstCommand = randomUUID();
    const secondCommand = randomUUID();
    const pending = Promise.all([
      systemUnitOfWork().transaction((tx) => tx.entitlements.fulfillProduct({
        commandId: firstCommand,
        offerCode: "self_paced",
        sourceId: "same-account-academy-race-a",
        sourceKind: "purchase",
        startsAt: now,
      })),
      systemUnitOfWork().transaction((tx) => tx.entitlements.fulfillProduct({
        commandId: secondCommand,
        offerCode: "guided_pilot",
        sourceId: "same-account-academy-race-b",
        sourceKind: "purchase",
        startsAt: now,
      })),
    ]);
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 2);
    await blocker.query(
      "select pg_advisory_unlock(hashtextextended($1,0))",
      [accountLockKey],
    );
    blocker.release();
    const outcomes = await pending;
    expect(outcomes.every(({ status }) => status === "applied")).toBe(true);
    const values = outcomes.flatMap((outcome) => outcome.status === "applied"
      ? [outcome.value]
      : []);
    expect(values.map(({ fulfillmentStatus }) => fulfillmentStatus).sort())
      .toEqual(["fulfilled", "reconciliation"]);
    expect((await harness.database.pool.query<{
      active_academies: number;
      fulfilled: number;
      reconciliations: number;
      sources: number;
    }>(`select
        (select count(*)::int from entitlement_grants
          where account_id=$1 and capability='academy_course'
            and status in ('active','grace')) active_academies,
        count(*) filter(where r.status='fulfilled')::int fulfilled,
        count(*) filter(where r.status='reconciliation')::int reconciliations,
        count(*)::int sources
      from commerce_fulfillment_receipts r where r.account_id=$1`,
    [accountA])).rows[0]).toEqual({
      active_academies: 1,
      fulfilled: 1,
      reconciliations: 1,
      sources: 2,
    });
    expect(await commandEvidence(harness.database, firstCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect(await commandEvidence(harness.database, secondCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
  });

  it("lets exactly one concurrent duplicate grant row commit", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const administrativeSource = randomUUID();
    await harness.database.pool.query(
      `insert into entitlement_sources
        (id,account_id,source_kind,source_id,offer_code,provenance,created_at)
       values($1,$2,'administrative','duplicate-grant-race',null,'race-test',$3)`,
      [administrativeSource, accountA, now],
    );
    const first = await harness.database.pool.connect();
    const second = await harness.database.pool.connect();
    try {
      await first.query("begin");
      await first.query(
        `insert into entitlement_grants
          (id,account_id,source_registry_id,source_kind,source_id,offer_code,
           capability,status,starts_at,ends_at,provenance,created_at,updated_at)
         values($1,$2,$3,'administrative','duplicate-grant-race',null,
           'support','active',$4,null,'race-test',$4,$4)`,
        [randomUUID(), accountA, administrativeSource, now],
      );
      const secondPending = (async () => {
        await second.query("begin");
        try {
          await second.query(
            `insert into entitlement_grants
              (id,account_id,source_registry_id,source_kind,source_id,offer_code,
               capability,status,starts_at,ends_at,provenance,created_at,updated_at)
             values($1,$2,$3,'administrative','duplicate-grant-race',null,
               'support','active',$4,null,'race-test',$4,$4)`,
            [randomUUID(), accountA, administrativeSource, now],
          );
          await second.query("commit");
          return { status: "fulfilled" as const };
        } catch (error) {
          await second.query("rollback").catch(() => undefined);
          return { status: "rejected" as const, error };
        }
      })();
      await waitForBlockerWaiters(harness.database, first, 1);
      await first.query("commit");
      const secondResult = await secondPending;
      expect(secondResult.status).toBe("rejected");
      if (secondResult.status !== "rejected") {
        throw new Error("EXPECTED_DUPLICATE_GRANT_REJECTION");
      }
      expect(databaseErrorCode(secondResult.error)).toBe("23505");
    } finally {
      await first.query("rollback").catch(() => undefined);
      await second.query("rollback").catch(() => undefined);
      first.release();
      second.release();
    }
    expect((await harness.database.pool.query<{
      academy_bundle: number;
      duplicate_grants: number;
    }>(`select
        count(*) filter(where source_registry_id=$1)::int duplicate_grants,
        count(*) filter(where source_registry_id=$2)::int academy_bundle
      from entitlement_grants`, [administrativeSource, sourceA])).rows[0])
      .toEqual({ academy_bundle: 3, duplicate_grants: 1 });
  });

  it("keeps same-account provider-shape collisions independent from parked receipts", async () => {
    await seedAccount(accountA);
    const parked = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recordBusinessOsSetupPurchase({
        commandId: randomUUID(),
        sourceId: "setup-shape-collision",
        purchasedAt: now,
      }));
    const setup = recordedSetup(parked);
    const collisionInput = {
      offerCode: "self_paced" as const,
      sourceId: "setup-shape-collision",
      sourceKind: "purchase" as const,
      startsAt: now,
    };
    const conflict = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(), ...collisionInput }));
    expect(conflict).toMatchObject({
      status: "applied",
      value: {
        fulfillmentStatus: "reconciliation",
        reconciliationKind: "provider_collision",
        sourceRegistryId: null,
      },
    });
    if (conflict.status !== "applied"
      || conflict.value.fulfillmentStatus !== "reconciliation"
      || conflict.value.reconciliationKind !== "provider_collision") {
      throw new Error("EXPECTED_PROVIDER_COLLISION");
    }
    const collisionId = conflict.value.reconciliationId;
    if (collisionId === null) throw new Error("EXPECTED_PROVIDER_COLLISION_ID");
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.claimCommerceReconciliation({
        commandId: randomUUID(),
        reconciliationId: collisionId,
      })));
    applied(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.resolveCommerceReconciliation({
        commandId: randomUUID(),
        reconciliationId: collisionId,
        resolution: "manual",
        reason: "The misrouted provider event was closed without changing setup",
      })));
    expect((await harness.database.pool.query<{ status: string }>(
      "select status from business_os_setup_receipts where source_registry_id=$1",
      [setup.sourceRegistryId],
    )).rows[0]?.status).toBe("paid");
    expect((await harness.database.pool.query<{ status: string }>(
      "select status from commerce_reconciliations where id=$1",
      [collisionId],
    )).rows[0]?.status).toBe("resolved_manual");
    const redeliveryId = randomUUID();
    const redelivery = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: redeliveryId, ...collisionInput }));
    expect(redelivery).toMatchObject({ status: "applied", value: {
      fulfillmentStatus: "reconciliation",
      reconciliationId: collisionId,
    } });
    expect((await harness.database.pool.query<{ type: string }>(
      "select type from outbox_events where event_id=$1", [redeliveryId],
    )).rows[0]?.type).toBe("entitlements.command_applied.v1");
    expect(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.listCommerceReconciliations())).toEqual([]);
  });

  it("keeps raw entitlement data closed to coaches even when session GUCs are spoofed", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const coachId = "30000000-0000-4000-8000-000000000002";
    await harness.database.pool.query(
      `insert into staff_identities(id,provider_user_id,role,permissions)
       values($1,'workos-coach','coach',array[]::text[])`,
      [coachId],
    );
    expect((await harness.database.pool.query<{ allowed: boolean }>(
      `select has_table_privilege($1,'entitlement_sources','select') allowed`,
      [staff.roleName],
    )).rows[0]?.allowed).toBe(false);

    const client = await staff.database.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `select set_config('app.account_id',$1,true),
          set_config('app.actor_id',$2,true),
          set_config('app.actor_kind','staff',true),
          set_config('app.actor_role','admin',true),
          set_config('app.actor_permissions','["entitlements:manage"]',true),
          set_config('app.authenticated_at',$3,true)`,
        [accountA, coachId, now.toISOString()],
      );
      await expect(client.query(
        "select * from syntholo_list_commerce_reconciliations($1,null,50,$2)",
        [accountA, now],
      )).rejects.toSatisfy((error: unknown) => databaseErrorCode(error) === "42501");
      await client.query("rollback");
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }

    const coach = trustedStaffActor({
      kind: "staff" as const,
      actorId: coachId,
      workosUserId: "workos-coach",
      staffId: coachId,
      role: "coach" as const,
      permissions: Object.freeze([]),
      authenticatedAt: now,
    });
    await expect(staffUnitOfWork(accountA, randomUUID(), now, coach)
      .transaction((tx) => tx.entitlements.listCommerceReconciliations()))
      .rejects.toThrow("STAFF_ENTITLEMENT_AUTHORITY_REQUIRED");
    expect(await staffUnitOfWork().transaction((tx) =>
      tx.entitlements.listCommerceReconciliations())).toEqual([]);
  });

  it("allows only pending revocation under a seat hold and reuses free slot one", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const firstToken = Buffer.alloc(32, 71);
    const pending = applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: sourceA, email: "pending-held@example.test",
        tokenHash: firstToken })));
    const activeToken = Buffer.alloc(32, 72);
    const activeInvite = applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: sourceA, email: "active-held@example.test",
        tokenHash: activeToken })));
    const active = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.redeemInvitation({ commandId: randomUUID(),
        clerkUserId: "active-held", email: "active-held@example.test",
        tokenHash: activeToken })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.openDispute({ commandId: randomUUID(),
        disputeId: "dp_seat_hold", targetSourceRegistryId: sourceA })));
    expect((await ownerUnitOfWork().transaction((tx) => tx.entitlements.revokeSeat({
      commandId: randomUUID(), reason: "Withdraw pending invite",
      reservationId: pending.reservationId,
    }))).status).toBe("applied");
    const activeDeniedId = randomUUID();
    expect(await ownerUnitOfWork().transaction((tx) => tx.entitlements.revokeSeat({
      commandId: activeDeniedId, reason: "Cannot remove while held",
      reservationId: active.reservationId,
    }))).toMatchObject({ status: "denied", code: "SEAT_CHANGES_HELD" });
    expect(await commandEvidence(harness.database, activeDeniedId))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    expect(activeInvite.slot).toBe(3);
  });

  it("uses the lowest free slot after ownership transfer releases slot one", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const token = Buffer.alloc(32, 73);
    applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: sourceA, email: "next-owner@example.test",
        tokenHash: token })));
    const nextOwner = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.redeemInvitation({ commandId: randomUUID(),
        clerkUserId: "next-owner", email: "next-owner@example.test",
        tokenHash: token })));
    const formerOwnerSeat = (await harness.database.pool.query<{ id: string }>(
      "select id from seat_reservations where membership_id=$1 and state='active'",
      [membershipA],
    )).rows[0]!.id;
    applied(await ownerUnitOfWork().transaction((tx) =>
      tx.entitlements.transferOwnership({ commandId: randomUUID(),
        reason: "Move ownership", targetMembershipId: nextOwner.membershipId })));
    const nextOwnerIdentity = (await harness.database.pool.query<{
      member_identity_id: string;
    }>("select member_identity_id from memberships where id=$1",
    [nextOwner.membershipId])).rows[0]!.member_identity_id;
    const nextOwnerUow = createUnitOfWork(member.database, {
      accountId: accountA,
      actor: trustedMemberActor({ kind: "member", actorId: nextOwnerIdentity,
        accountId: accountA, clerkUserId: "next-owner",
        membershipId: nextOwner.membershipId, role: "owner", authenticatedAt: now }),
      correlationId: randomUUID(), clock: { now: () => now },
    });
    applied(await nextOwnerUow.transaction((tx) => tx.entitlements.revokeSeat({
      commandId: randomUUID(), reason: "Former owner departed",
      reservationId: formerOwnerSeat,
    })));
    const replacement = applied(await nextOwnerUow.transaction((tx) =>
      tx.entitlements.reservePendingSeat({ commandId: randomUUID(),
        sourceRegistryId: sourceA, email: "slot-one@example.test",
        tokenHash: Buffer.alloc(32, 74) })));
    expect(replacement.slot).toBe(1);
  });

  it("applies exact Club grace recovery cancellation and expiry without changing Academy", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const clubSource = randomUUID();
    const clubStart = now;
    const paidThrough = new Date(now.getTime() + 24 * 3_600_000);
    await inTransaction(harness.database.pool, async (client) => {
      await client.query(`insert into entitlement_sources
        (id,account_id,source_kind,source_id,offer_code,academy_source_registry_id,
         provenance,created_at) values($1,$2,'subscription','club-lifecycle',
         'operator_club_monthly',$3,'test',$4)`, [clubSource, accountA, sourceA, now]);
      await client.query(`insert into entitlement_grants
        (account_id,source_registry_id,source_kind,source_id,offer_code,capability,
         status,starts_at,ends_at,provenance,created_at,updated_at)
        select $1,$2,'subscription','club-lifecycle','operator_club_monthly',capability,
          'active',$3,$4,'test',$3,$3 from unnest(array['support','circle_write','operator_club']) capability`,
      [accountA, clubSource, clubStart, paidThrough]);
    });
    const failedAt = paidThrough;
    const grace = applied(await systemUnitOfWork(accountA, randomUUID(), failedAt)
      .transaction((tx) => tx.entitlements.markClubPaymentFailed({
        commandId: randomUUID(), paidThroughAt: paidThrough,
        sourceRegistryId: clubSource,
      })));
    expect(grace.graceEndsAt).toEqual(new Date(paidThrough.getTime() + 168 * 3_600_000));
    const recoveredThrough = new Date(grace.graceEndsAt.getTime() + 30 * 86_400_000);
    applied(await systemUnitOfWork(accountA, randomUUID(), new Date(failedAt.getTime() + 1))
      .transaction((tx) => tx.entitlements.recoverClubPayment({
        commandId: randomUUID(), paidThroughAt: recoveredThrough,
        sourceRegistryId: clubSource,
      })));
    applied(await systemUnitOfWork().transaction((tx) => tx.entitlements.cancelClub({
      commandId: randomUUID(), paidThroughAt: recoveredThrough,
      sourceRegistryId: clubSource,
    })));
    applied(await systemUnitOfWork(accountA, randomUUID(), recoveredThrough)
      .transaction((tx) => tx.entitlements.expireClub({
        commandId: randomUUID(), sourceRegistryId: clubSource,
      })));
    const states = await harness.database.pool.query<{
      source_registry_id: string; capability: string; status: string;
    }>("select source_registry_id,capability,status from entitlement_grants order by source_registry_id,capability");
    expect(states.rows.filter((row) => row.source_registry_id === clubSource)
      .every(({ status }) => status === "expired")).toBe(true);
    expect(states.rows.find(({ capability }) => capability === "academy_course")?.status)
      .toBe("active");
  });

  it("makes Club cancellation authoritative over failure in either event order", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const paidThrough = new Date(now.getTime() + 86_400_000);
    const createClub = async (sourceId: string) => applied(
      await systemUnitOfWork().transaction((tx) => tx.entitlements.fulfillProduct({
        commandId: randomUUID(), academySourceRegistryId: sourceA,
        offerCode: "operator_club_monthly", sourceId,
        sourceKind: "subscription", startsAt: now, endsAt: paidThrough,
      })),
    );

    const failureThenCancel = await createClub("club-failure-then-cancel");
    applied(await systemUnitOfWork(accountA, randomUUID(), paidThrough)
      .transaction((tx) => tx.entitlements.markClubPaymentFailed({
        commandId: randomUUID(), paidThroughAt: paidThrough,
        sourceRegistryId: failureThenCancel.sourceRegistryId,
      })));
    applied(await systemUnitOfWork(accountA, randomUUID(), paidThrough)
      .transaction((tx) => tx.entitlements.cancelClub({
        commandId: randomUUID(), paidThroughAt: paidThrough,
        sourceRegistryId: failureThenCancel.sourceRegistryId,
      })));
    const firstState = await harness.database.pool.query<{
      status: string; ends_at: Date;
    }>(`select distinct status,ends_at from entitlement_grants
        where source_registry_id=$1`, [failureThenCancel.sourceRegistryId]);
    expect(firstState.rows).toEqual([{ status: "expired", ends_at: paidThrough }]);

    const secondStart = new Date(paidThrough.getTime() + 1);
    const secondEnd = new Date(secondStart.getTime() + 86_400_000);
    const cancelThenFailure = applied(await systemUnitOfWork(accountA, randomUUID(), secondStart)
      .transaction((tx) => tx.entitlements.fulfillProduct({
        commandId: randomUUID(), academySourceRegistryId: sourceA,
        offerCode: "operator_club_monthly", sourceId: "club-cancel-then-failure",
        sourceKind: "subscription", startsAt: secondStart, endsAt: secondEnd,
      })));
    const cancelId = randomUUID();
    applied(await systemUnitOfWork(accountA, randomUUID(), secondStart)
      .transaction((tx) => tx.entitlements.cancelClub({ commandId: cancelId,
        paidThroughAt: secondEnd, sourceRegistryId: cancelThenFailure.sourceRegistryId })));
    const failureId = randomUUID();
    expect(await systemUnitOfWork(accountA, randomUUID(), secondEnd)
      .transaction((tx) => tx.entitlements.markClubPaymentFailed({
        commandId: failureId, paidThroughAt: secondEnd,
        sourceRegistryId: cancelThenFailure.sourceRegistryId,
      }))).toMatchObject({ status: "denied", code: "CLUB_ACTIVE_INTERVAL_REQUIRED" });
    expect(await systemUnitOfWork(accountA, randomUUID(), secondEnd)
      .transaction((tx) => tx.entitlements.recoverClubPayment({
        commandId: randomUUID(), paidThroughAt: new Date(secondEnd.getTime() + 86_400_000),
        sourceRegistryId: cancelThenFailure.sourceRegistryId,
      }))).toMatchObject({ status: "denied", code: "CLUB_GRACE_RECOVERY_UNAVAILABLE" });
    expect(await commandEvidence(harness.database, cancelId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect(await commandEvidence(harness.database, failureId))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
  });

  it("converges duplicate Club cancellation events and rejects conflicting grace terms", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const paidThrough = new Date(now.getTime() + 86_400_000);
    const club = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        academySourceRegistryId: sourceA, offerCode: "operator_club_monthly",
        sourceId: "club-cancellation-convergence", sourceKind: "subscription",
        startsAt: now, endsAt: paidThrough })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.markClubPaymentFailed({ commandId: randomUUID(),
        paidThroughAt: paidThrough, sourceRegistryId: club.sourceRegistryId })));
    const wrongTerm = new Date(paidThrough.getTime() + 1);
    expect(await systemUnitOfWork().transaction((tx) => tx.entitlements.cancelClub({
      commandId: randomUUID(), paidThroughAt: wrongTerm,
      sourceRegistryId: club.sourceRegistryId,
    }))).toMatchObject({ status: "denied", code: "CLUB_CANCELLATION_UNAVAILABLE" });
    applied(await systemUnitOfWork().transaction((tx) => tx.entitlements.cancelClub({
      commandId: randomUUID(), paidThroughAt: paidThrough,
      sourceRegistryId: club.sourceRegistryId,
    })));
    const duplicateId = randomUUID();
    expect(applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.cancelClub({ commandId: duplicateId,
        paidThroughAt: paidThrough, sourceRegistryId: club.sourceRegistryId }))))
      .toEqual({ sourceRegistryId: club.sourceRegistryId,
        paidThroughAt: paidThrough });
    expect(await commandEvidence(harness.database, duplicateId))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    const conflictCommand = randomUUID();
    const conflict = await systemUnitOfWork().transaction((tx) => tx.entitlements.cancelClub({
      commandId: conflictCommand, paidThroughAt: wrongTerm,
      sourceRegistryId: club.sourceRegistryId,
    }));
    expect(conflict).toMatchObject({ status: "applied", value: {
      sourceRegistryId: club.sourceRegistryId,
      paidThroughAt: paidThrough,
      reconciliationId: expect.any(String),
      reconciliationStatus: "open",
    } });
    expect(await commandEvidence(harness.database, conflictCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect((await harness.database.pool.query<{ source_id: string; status: string }>(
      `select source_id,status from commerce_reconciliations
       where command_kind='club_cancelled'`,
    )).rows).toEqual([{ source_id: "club-cancellation-convergence", status: "open" }]);
  });

  it("expires included support at its half-open boundary and leaves lifetime Academy", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const before = await systemUnitOfWork(accountA, randomUUID(), new Date(now.getTime() - 1))
      .transaction((tx) => tx.entitlements.expireIncludedSupport({
        commandId: randomUUID(), sourceRegistryId: sourceA,
      }));
    expect(before).toMatchObject({ status: "denied", code: "SUPPORT_NOT_DUE" });
    const expired = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.expireIncludedSupport({
        commandId: randomUUID(), sourceRegistryId: sourceA,
      })));
    expect(expired.expiredCapabilities).toEqual(["support", "circle_write"]);
    const rows = await harness.database.pool.query<{ capability: string; status: string }>(
      "select capability,status from entitlement_grants where source_registry_id=$1 order by capability",
      [sourceA],
    );
    expect(rows.rows).toEqual([
      { capability: "academy_course", status: "active" },
      { capability: "circle_write", status: "expired" },
      { capability: "support", status: "expired" },
    ]);
  });

  it("renews and expires Business OS without changing Academy", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const originalEnd = new Date(now.getTime() + 86_400_000);
    const business = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "business_os", sourceId: "bo_lifecycle",
        sourceKind: "subscription", startsAt: now, endsAt: originalEnd })));
    const renewedEnd = new Date(originalEnd.getTime() + 30 * 86_400_000);
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.renewBusinessOs({ commandId: randomUUID(),
        paidThroughAt: renewedEnd, sourceRegistryId: business.sourceRegistryId })));
    const staleCancellationId = randomUUID();
    expect(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.cancelBusinessOs({ commandId: staleCancellationId,
        paidThroughAt: originalEnd, sourceRegistryId: business.sourceRegistryId })))
      .toMatchObject({ status: "denied", code: "BUSINESS_OS_CANCELLATION_UNAVAILABLE" });
    expect(await commandEvidence(harness.database, staleCancellationId))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    expect((await harness.database.pool.query<{ ends_at: Date }>(
      "select ends_at from entitlement_grants where source_registry_id=$1",
      [business.sourceRegistryId],
    )).rows[0]?.ends_at).toEqual(renewedEnd);
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.cancelBusinessOs({ commandId: randomUUID(),
        paidThroughAt: renewedEnd, sourceRegistryId: business.sourceRegistryId })));
    applied(await systemUnitOfWork(accountA, randomUUID(), renewedEnd).transaction((tx) =>
      tx.entitlements.expireBusinessOs({ commandId: randomUUID(),
        sourceRegistryId: business.sourceRegistryId })));
    const rows = await harness.database.pool.query<{ capability: string; status: string }>(
      "select capability,status from entitlement_grants order by capability",
    );
    expect(rows.rows.find(({ capability }) => capability === "business_os")?.status)
      .toBe("expired");
    expect(rows.rows.find(({ capability }) => capability === "academy_course")?.status)
      .toBe("active");
  });

  it("records an already-ended Business OS payment as expired and leaves re-entry free", async () => {
    await seedAccount(accountA);
    const staleStart = new Date(now.getTime() - 2 * 86_400_000);
    const staleEnd = new Date(now.getTime() - 86_400_000);
    const stale = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "business_os", sourceId: "bo-delayed-ended-payment",
        sourceKind: "subscription", startsAt: staleStart, endsAt: staleEnd })));
    expect((await harness.database.pool.query<{ status: string }>(
      "select status from entitlement_grants where source_registry_id=$1",
      [stale.sourceRegistryId],
    )).rows).toEqual([{ status: "expired" }]);
    const current = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "business_os", sourceId: "bo-after-delayed-ended-payment",
        sourceKind: "subscription", startsAt: now,
        endsAt: new Date(now.getTime() + 86_400_000) })));
    expect((await harness.database.pool.query<{ status: string }>(
      "select status from entitlement_grants where source_registry_id=$1",
      [current.sourceRegistryId],
    )).rows).toEqual([{ status: "active" }]);
  });

  it("applies exact Business OS grace recovery and cancellation precedence", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const paidThrough = new Date(now.getTime() + 86_400_000);
    const business = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "business_os", sourceId: "bo-grace-lifecycle",
        sourceKind: "subscription", startsAt: now, endsAt: paidThrough })));
    const failureId = randomUUID();
    const failureInput = { commandId: failureId, paidThroughAt: paidThrough,
      sourceRegistryId: business.sourceRegistryId };
    const firstFailure = applied(await systemUnitOfWork(accountA, randomUUID(), paidThrough)
      .transaction((tx) => tx.entitlements.markBusinessOsPaymentFailed(failureInput)));
    expect(firstFailure.graceEndsAt)
      .toEqual(new Date(paidThrough.getTime() + 168 * 3_600_000));
    const replay = await systemUnitOfWork(accountA, randomUUID(), new Date(paidThrough.getTime() + 1))
      .transaction((tx) => tx.entitlements.markBusinessOsPaymentFailed(failureInput));
    expect(replay).toMatchObject({ status: "applied", replayed: true });
    const recoveredThrough = new Date(firstFailure.graceEndsAt.getTime() + 86_400_000);
    applied(await systemUnitOfWork(accountA, randomUUID(), new Date(paidThrough.getTime() + 1))
      .transaction((tx) => tx.entitlements.recoverBusinessOsPayment({
        commandId: randomUUID(), paidThroughAt: recoveredThrough,
        sourceRegistryId: business.sourceRegistryId })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.cancelBusinessOs({ commandId: randomUUID(),
        paidThroughAt: recoveredThrough, sourceRegistryId: business.sourceRegistryId })));
    expect(await systemUnitOfWork(accountA, randomUUID(), recoveredThrough)
      .transaction((tx) => tx.entitlements.markBusinessOsPaymentFailed({
        commandId: randomUUID(), paidThroughAt: recoveredThrough,
        sourceRegistryId: business.sourceRegistryId })))
      .toMatchObject({ status: "denied", code: "BUSINESS_OS_ACTIVE_INTERVAL_REQUIRED" });
    expect(await systemUnitOfWork(accountA, randomUUID(), recoveredThrough)
      .transaction((tx) => tx.entitlements.recoverBusinessOsPayment({
        commandId: randomUUID(),
        paidThroughAt: new Date(recoveredThrough.getTime() + 86_400_000),
        sourceRegistryId: business.sourceRegistryId })))
      .toMatchObject({ status: "denied", code: "BUSINESS_OS_GRACE_RECOVERY_UNAVAILABLE" });
    applied(await systemUnitOfWork(accountA, randomUUID(), recoveredThrough)
      .transaction((tx) => tx.entitlements.expireBusinessOs({
        commandId: randomUUID(), sourceRegistryId: business.sourceRegistryId })));
    const rows = await harness.database.pool.query<{ capability: string; status: string }>(
      "select capability,status from entitlement_grants order by capability",
    );
    expect(rows.rows.find(({ capability }) => capability === "business_os")?.status)
      .toBe("expired");
    expect(rows.rows.find(({ capability }) => capability === "academy_course")?.status)
      .toBe("active");
  });

  it("expires Business OS grace at the exact boundary and creates a new epoch", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const paidThrough = new Date(now.getTime() + 86_400_000);
    const first = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({
        commandId: randomUUID(), offerCode: "business_os",
        sourceId: "bo-grace-terminal-first", sourceKind: "subscription",
        startsAt: now, endsAt: paidThrough,
      })));
    const grace = applied(await systemUnitOfWork(accountA, randomUUID(), paidThrough)
      .transaction((tx) => tx.entitlements.markBusinessOsPaymentFailed({
        commandId: randomUUID(), paidThroughAt: paidThrough,
        sourceRegistryId: first.sourceRegistryId,
      })));
    const justBefore = new Date(grace.graceEndsAt.getTime() - 1);
    expect(await systemUnitOfWork(accountA, randomUUID(), justBefore)
      .transaction((tx) => tx.entitlements.expireBusinessOs({
        commandId: randomUUID(), sourceRegistryId: first.sourceRegistryId,
      }))).toMatchObject({ status: "denied", code: "BUSINESS_OS_EXPIRY_NOT_DUE" });
    applied(await systemUnitOfWork(accountA, randomUUID(), grace.graceEndsAt)
      .transaction((tx) => tx.entitlements.expireBusinessOs({
        commandId: randomUUID(), sourceRegistryId: first.sourceRegistryId,
      })));

    const secondEnd = new Date(grace.graceEndsAt.getTime() + 30 * 86_400_000);
    const second = applied(await systemUnitOfWork(
      accountA, randomUUID(), grace.graceEndsAt,
    ).transaction((tx) => tx.entitlements.fulfillProduct({
      commandId: randomUUID(), offerCode: "business_os",
      sourceId: "bo-grace-terminal-second", sourceKind: "subscription",
      startsAt: grace.graceEndsAt, endsAt: secondEnd,
    })));
    const history = await harness.database.pool.query<{
      source_registry_id: string; starts_at: Date; status: string;
    }>(`select source_registry_id,starts_at,status from entitlement_grants
        where capability='business_os' order by starts_at`);
    expect(history.rows).toEqual([
      { source_registry_id: first.sourceRegistryId, starts_at: now, status: "expired" },
      { source_registry_id: second.sourceRegistryId,
        starts_at: grace.graceEndsAt, status: "active" },
    ]);
    expect(second.sourceRegistryId).not.toBe(first.sourceRegistryId);
  });

  it("makes Business OS cancellation authoritative over failure in either order", async () => {
    await seedAccount(accountA);
    const paidThrough = new Date(now.getTime() + 86_400_000);
    const first = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "business_os", sourceId: "bo-failure-then-cancel",
        sourceKind: "subscription", startsAt: now, endsAt: paidThrough })));
    applied(await systemUnitOfWork(accountA, randomUUID(), paidThrough)
      .transaction((tx) => tx.entitlements.markBusinessOsPaymentFailed({
        commandId: randomUUID(), paidThroughAt: paidThrough,
        sourceRegistryId: first.sourceRegistryId })));
    applied(await systemUnitOfWork(accountA, randomUUID(), paidThrough)
      .transaction((tx) => tx.entitlements.cancelBusinessOs({
        commandId: randomUUID(), paidThroughAt: paidThrough,
        sourceRegistryId: first.sourceRegistryId })));
    expect((await harness.database.pool.query<{ status: string; ends_at: Date }>(
      "select status,ends_at from entitlement_grants where source_registry_id=$1",
      [first.sourceRegistryId],
    )).rows).toEqual([{ status: "expired", ends_at: paidThrough }]);

    const secondStart = new Date(paidThrough.getTime() + 1);
    const secondEnd = new Date(secondStart.getTime() + 86_400_000);
    const second = applied(await systemUnitOfWork(accountA, randomUUID(), secondStart)
      .transaction((tx) => tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "business_os", sourceId: "bo-cancel-then-failure",
        sourceKind: "subscription", startsAt: secondStart, endsAt: secondEnd })));
    applied(await systemUnitOfWork(accountA, randomUUID(), secondStart)
      .transaction((tx) => tx.entitlements.cancelBusinessOs({
        commandId: randomUUID(), paidThroughAt: secondEnd,
        sourceRegistryId: second.sourceRegistryId })));
    const failureId = randomUUID();
    expect(await systemUnitOfWork(accountA, randomUUID(), secondEnd)
      .transaction((tx) => tx.entitlements.markBusinessOsPaymentFailed({
        commandId: failureId, paidThroughAt: secondEnd,
        sourceRegistryId: second.sourceRegistryId })))
      .toMatchObject({ status: "denied", code: "BUSINESS_OS_ACTIVE_INTERVAL_REQUIRED" });
    expect(await commandEvidence(harness.database, failureId))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
  });

  it("converges duplicate Business OS cancellation events and rejects conflicting grace terms", async () => {
    await seedAccount(accountA);
    const paidThrough = new Date(now.getTime() + 86_400_000);
    const business = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        offerCode: "business_os", sourceId: "bo-cancellation-convergence",
        sourceKind: "subscription", startsAt: now, endsAt: paidThrough })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.markBusinessOsPaymentFailed({ commandId: randomUUID(),
        paidThroughAt: paidThrough, sourceRegistryId: business.sourceRegistryId })));
    const wrongTerm = new Date(paidThrough.getTime() + 1);
    expect(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.cancelBusinessOs({ commandId: randomUUID(),
        paidThroughAt: wrongTerm, sourceRegistryId: business.sourceRegistryId })))
      .toMatchObject({ status: "denied",
        code: "BUSINESS_OS_CANCELLATION_UNAVAILABLE" });
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.cancelBusinessOs({ commandId: randomUUID(),
        paidThroughAt: paidThrough, sourceRegistryId: business.sourceRegistryId })));
    expect(applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.cancelBusinessOs({ commandId: randomUUID(),
        paidThroughAt: paidThrough, sourceRegistryId: business.sourceRegistryId }))))
      .toEqual({ sourceRegistryId: business.sourceRegistryId,
        paidThroughAt: paidThrough });
    const conflictCommand = randomUUID();
    const conflict = await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.cancelBusinessOs({ commandId: conflictCommand,
        paidThroughAt: wrongTerm, sourceRegistryId: business.sourceRegistryId }));
    expect(conflict).toMatchObject({ status: "applied", value: {
      sourceRegistryId: business.sourceRegistryId,
      paidThroughAt: paidThrough,
      reconciliationId: expect.any(String),
      reconciliationStatus: "open",
    } });
    expect(await commandEvidence(harness.database, conflictCommand))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect((await harness.database.pool.query<{ source_id: string; status: string }>(
      `select source_id,status from commerce_reconciliations
       where command_kind='business_os_cancelled'`,
    )).rows).toEqual([{ source_id: "bo-cancellation-convergence", status: "open" }]);
  });

  it("renews an active Club subscription without creating a new source", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const firstEnd = new Date(now.getTime() + 86_400_000);
    const club = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        academySourceRegistryId: sourceA, offerCode: "operator_club_monthly",
        sourceId: "club_active_renewal", sourceKind: "subscription",
        startsAt: now, endsAt: firstEnd })));
    const renewedEnd = new Date(firstEnd.getTime() + 30 * 86_400_000);
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.recoverClubPayment({ commandId: randomUUID(),
        paidThroughAt: renewedEnd, sourceRegistryId: club.sourceRegistryId })));
    const staleCancellationId = randomUUID();
    expect(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.cancelClub({ commandId: staleCancellationId,
        paidThroughAt: firstEnd, sourceRegistryId: club.sourceRegistryId })))
      .toMatchObject({ status: "denied", code: "CLUB_CANCELLATION_UNAVAILABLE" });
    expect(await commandEvidence(harness.database, staleCancellationId))
      .toEqual({ decisions: 1, audits: 1, outbox: 0 });
    const rows = await harness.database.pool.query<{
      ends_at: Date; sources: number;
    }>(`select min(g.ends_at) ends_at,
      (select count(*)::int from entitlement_sources where account_id=$1
       and offer_code in ('operator_club_monthly','operator_club_annual')) sources
      from entitlement_grants g where g.source_registry_id=$2`,
    [accountA, club.sourceRegistryId]);
    expect(rows.rows[0]).toEqual({ ends_at: renewedEnd, sources: 1 });
  });

  it("creates a new Club epoch after terminal expiry without reactivating history", async () => {
    await seedAccount(accountA);
    await seedAcademyBundle(harness.database);
    const firstEnd = new Date(now.getTime() + 86_400_000);
    const first = applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.fulfillProduct({ commandId: randomUUID(),
        academySourceRegistryId: sourceA, offerCode: "operator_club_monthly",
        sourceId: "club-terminal-first", sourceKind: "subscription",
        startsAt: now, endsAt: firstEnd })));
    applied(await systemUnitOfWork().transaction((tx) =>
      tx.entitlements.cancelClub({ commandId: randomUUID(),
        paidThroughAt: firstEnd, sourceRegistryId: first.sourceRegistryId })));
    applied(await systemUnitOfWork(accountA, randomUUID(), firstEnd).transaction((tx) =>
      tx.entitlements.expireClub({ commandId: randomUUID(),
        sourceRegistryId: first.sourceRegistryId })));
    const secondEnd = new Date(firstEnd.getTime() + 30 * 86_400_000);
    const commandA = randomUUID();
    const commandB = randomUUID();
    const accountLockKey = `syntholo-entitlement-account:${accountA}`;
    const blocker = await harness.database.pool.connect();
    await blocker.query(
      "select pg_advisory_lock(hashtextextended($1,0))",
      [accountLockKey],
    );
    const pending = Promise.all([
      systemUnitOfWork(accountA, randomUUID(), firstEnd).transaction((tx) =>
        tx.entitlements.fulfillProduct({
        commandId: commandA, academySourceRegistryId: sourceA,
        offerCode: "operator_club_monthly", sourceId: "club-terminal-second-a",
        sourceKind: "subscription", startsAt: firstEnd, endsAt: secondEnd,
      })),
      systemUnitOfWork(accountA, randomUUID(), firstEnd).transaction((tx) =>
        tx.entitlements.fulfillProduct({
        commandId: commandB, academySourceRegistryId: sourceA,
        offerCode: "operator_club_annual", sourceId: "club-terminal-second-b",
        sourceKind: "subscription", startsAt: firstEnd, endsAt: secondEnd,
      })),
    ]);
    await waitForAdvisoryKeyWaiters(harness.database, accountLockKey, 2);
    await blocker.query(
      "select pg_advisory_unlock(hashtextextended($1,0))",
      [accountLockKey],
    );
    blocker.release();
    const [secondA, secondB] = await pending;
    expect([secondA.status, secondB.status]).toEqual(["applied", "applied"]);
    expect([secondA, secondB].filter((outcome) => outcome.status === "applied")
      .map((outcome) => outcome.value.fulfillmentStatus).sort())
      .toEqual(["fulfilled", "reconciliation"]);
    const history = await harness.database.pool.query<{
      source_registry_id: string; status: string;
    }>(`select distinct source_registry_id,status from entitlement_grants
        where offer_code in ('operator_club_monthly','operator_club_annual')
        order by source_registry_id,status`);
    expect(history.rows.filter(({ source_registry_id }) =>
      source_registry_id === first.sourceRegistryId)).toEqual([{
      source_registry_id: first.sourceRegistryId, status: "expired",
    }]);
    expect(new Set(history.rows.map(({ source_registry_id }) => source_registry_id)).size)
      .toBe(2);
    expect((await harness.database.pool.query<{ count: number }>(
      `select count(*)::int count from commerce_fulfillment_receipts
       where status='reconciliation'`,
    )).rows[0]?.count).toBe(1);
    expect(await commandEvidence(harness.database, commandA))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
    expect(await commandEvidence(harness.database, commandB))
      .toEqual({ decisions: 1, audits: 1, outbox: 1 });
  });

  it("keeps system writes behind a distinct trusted system unit of work", async () => {
    await seedAccount(accountA);
    expect(() => createUnitOfWork(system.database, {
      accountId: accountA,
      actor: { kind: "system", actorId: "commerce-webhook" },
      correlationId: "10000000-0000-4000-8000-000000000091",
      clock: { now: () => now },
    })).toThrow("TRANSACTION_METADATA_INVALID");
    const systemUow = createSystemUnitOfWork(trustedSystem, {
      accountId: accountA,
      actor: { kind: "system", actorId: "commerce-webhook" },
      correlationId: "10000000-0000-4000-8000-000000000091",
      clock: { now: () => now },
    });
    await expect(systemUow.transaction(async (tx) =>
      tx.entitlements.lockAccount(accountA),
    )).resolves.toBeUndefined();
  });
});
