import { createHmac, randomUUID } from "node:crypto";
import {
  attestSystemDatabase,
  createDatabase,
  type Database,
  type SystemDatabase,
} from "@syntholo/database";
import { createTestDatabaseHarness, type TestDatabaseHarness } from "@syntholo/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type ApiDependencies } from "../app.js";
import {
  createStripeWebhookHandler,
  createStripeWebhookRecordPort,
} from "./stripe-webhook.js";

const now = new Date("2026-08-15T17:00:01.000Z");
const timestamp = Math.floor(now.getTime() / 1_000);
const receiver = "acct_test_syntholo";
const secret = "syntholo_test_fake_webhook_current";
const binding = Object.freeze({
  receiverAccountId: receiver,
  expectedLivemode: false,
  expectedApiVersion: "2026-06-24.dahlia" as const,
  expectedEventAccount: null,
  expectedEventContext: null,
});

type RuntimeLogin = Readonly<{ database: Database; password: string; roleName: string }>;

function loginUrl(baseUrl: string, roleName: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function formatted(database: Database, template: string, values: string[]): Promise<string> {
  const parameters = values.map((_, index) => `$${index + 1}::text`).join(",");
  const result = await database.pool.query<{ statement: string }>(
    `select format($format$${template}$format$,${parameters}) statement`,
    values,
  );
  const statement = result.rows[0]?.statement;
  if (statement === undefined) throw new Error("TEST_SQL_FORMAT_FAILED");
  return statement;
}

async function createSystemLogin(owner: Database, baseUrl: string): Promise<RuntimeLogin> {
  const roleName = `syntholo_api_stripe_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  await owner.pool.query(await formatted(
    owner,
    "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
    [roleName, password],
  ));
  await owner.pool.query(await formatted(
    owner,
    "grant syntholo_system_api to %I with inherit true, set false, admin false",
    [roleName],
  ));
  return {
    database: createDatabase({
      applicationName: "syntholo-api-stripe-integration",
      url: loginUrl(baseUrl, roleName, password),
    }),
    password,
    roleName,
  };
}

async function dropSystemLogin(owner: Database, login: RuntimeLogin): Promise<void> {
  await login.database.close();
  await owner.pool.query(await formatted(
    owner,
    "revoke syntholo_system_api from %I",
    [login.roleName],
  ));
  await owner.pool.query(await formatted(owner, "drop role if exists %I", [login.roleName]));
}

function event(eventId: string, overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    id: eventId,
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: timestamp,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "invoice.paid",
    data: { object: { id: `in_${eventId}`, object: "invoice" } },
    ...overrides,
  }));
}

function signature(rawBody: Buffer): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret)
    .update(`${timestamp}.`).update(rawBody).digest("hex")}`;
}

async function contextualQuery<T>(
  database: Database,
  actorId: string,
  statement: string,
  values: unknown[],
): Promise<T[]> {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.actor_kind','system',true)");
    await client.query("select set_config('app.actor_id',$1,true)", [actorId]);
    await client.query("select set_config('app.account_id','',true)");
    await client.query("select set_config('app.correlation_id',$1,true)", [randomUUID()]);
    const result = await client.query<T & Record<string, unknown>>(statement, values);
    await client.query("commit");
    return result.rows;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function dependencies(database: SystemDatabase): ApiDependencies {
  const clock = Object.freeze({ now: () => now });
  return {
    releaseSha: "1".repeat(40),
    logger: false,
    health: { dependencies: [] },
    auth: { kind: "test-only-disabled" },
    stripe: {
      kind: "enabled",
      provider: { createCheckout: vi.fn(), createBillingPortal: vi.fn() },
      handler: createStripeWebhookHandler({
        binding,
        clock,
        endpointSecrets: [{ keyId: "stripe-webhook-current", secret }],
        record: createStripeWebhookRecordPort({ binding, clock, database }),
      }),
    },
  } as unknown as ApiDependencies;
}

describe.sequential("Stripe webhook API over the real system capability", () => {
  let harness: TestDatabaseHarness;
  let login: RuntimeLogin;
  let systemDatabase: SystemDatabase;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    login = await createSystemLogin(harness.database, baseUrl);
    systemDatabase = await attestSystemDatabase(login.database);
  }, 90_000);

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    if (login !== undefined) await dropSystemLogin(harness.database, login);
    await harness?.close();
  });

  it("inserts and exactly replays a signed minimized receipt without raw authority", async () => {
    const app = await buildApp(dependencies(systemDatabase));
    const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
    const rawBody = event(eventId);
    const request = {
      method: "POST" as const,
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature(rawBody) },
      payload: rawBody,
    };
    await expect(app.inject(request)).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject(request)).resolves.toMatchObject({ statusCode: 200 });

    const facts = await harness.database.pool.query(
      `select r.provider,r.provider_event_id,r.event_type,r.api_version,
              r.data_object_type,r.status,r.payload,p.status processing_status
         from provider_event_receipts r
         join provider_event_processing p on p.receipt_id=r.id
        where r.provider_event_id=$1`,
      [eventId],
    );
    expect(facts.rows).toEqual([{
      provider: "stripe",
      provider_event_id: eventId,
      event_type: "invoice.paid",
      api_version: "2026-06-24.dahlia",
      data_object_type: "invoice",
      status: "received",
      payload: {},
      processing_status: "received",
    }]);
    const serialized = JSON.stringify(facts.rows);
    expect(serialized).not.toContain(rawBody.toString("utf8"));
    expect(serialized).not.toContain(secret);
    await expect(login.database.pool.query("select * from provider_event_receipts"))
      .rejects.toThrow(/permission denied/u);
    await app.close();
  });

  it("durably terminalizes signed nullable-version and object-mismatch evidence with HTTP 200", async () => {
    const app = await buildApp(dependencies(systemDatabase));
    const nullableId = `evt_${randomUUID().replaceAll("-", "")}`;
    const nullable = event(nullableId, { api_version: null });
    const mismatchId = `evt_${randomUUID().replaceAll("-", "")}`;
    const mismatch = event(mismatchId, {
      data: { object: { id: `cus_${mismatchId}`, object: "customer" } },
    });
    for (const rawBody of [nullable, mismatch]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": signature(rawBody) },
        payload: rawBody,
      });
      expect(response.statusCode, response.payload).toBe(200);
    }
    const rows = await harness.database.pool.query(
      `select r.provider_event_id,r.api_version,p.status,p.outcome_code
         from provider_event_receipts r
         join provider_event_processing p on p.receipt_id=r.id
        order by r.provider_event_id`,
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_event_id: nullableId, api_version: null, status: "failed_terminal", outcome_code: "security_context_mismatch" }),
      expect.objectContaining({ provider_event_id: mismatchId, status: "failed_terminal", outcome_code: "event_object_mismatch" }),
    ]));
    await app.close();
  });

  it("maps a live processing lease and durable retryable failure to retryable HTTP 503", async () => {
    const app = await buildApp(dependencies(systemDatabase));
    const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
    const rawBody = event(eventId);
    const request = {
      method: "POST" as const,
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature(rawBody) },
      payload: rawBody,
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    const claimed = await contextualQuery<{ receipt_id: string; lease_token: string; lease_generation: number }>(
      login.database,
      "commerce-worker.v1",
      "select receipt_id,lease_token,lease_generation from syntholo_commerce_claim_provider_event_v1($1,$2,$3)",
      ["commerce-worker.v1", 60_000, "2026-08-15T17:00:02.000Z"],
    );
    const processing = await app.inject(request);
    expect(processing.statusCode).toBe(503);
    expect(processing.headers["retry-after"]).toBe("1");
    await contextualQuery(
      login.database,
      "commerce-worker.v1",
      "select * from syntholo_commerce_finish_provider_event_v1($1,$2,$3,$4,$5,$6,$7)",
      [claimed[0]?.receipt_id, "commerce-worker.v1", claimed[0]?.lease_token,
        claimed[0]?.lease_generation, "failed_retryable", "provider_unavailable",
        "2026-08-15T17:00:03.000Z"],
    );
    const retryable = await app.inject(request);
    expect(retryable.statusCode).toBe(503);
    expect(retryable.headers["retry-after"]).toBe("1");
    await app.close();
  });

  it("fails a signed immutable-envelope collision closed without creating a second receipt", async () => {
    const app = await buildApp(dependencies(systemDatabase));
    const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
    const original = event(eventId);
    const changed = event(eventId, {
      data: { object: { id: `in_changed_${eventId}`, object: "invoice" } },
    });
    const send = (rawBody: Buffer) => app.inject({
      method: "POST" as const,
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature(rawBody) },
      payload: rawBody,
    });
    expect((await send(original)).statusCode).toBe(200);
    const collision = await send(changed);
    expect(collision.statusCode).toBe(200);
    expect(collision.json()).toEqual({ received: true });
    await expect(harness.database.pool.query(
      `select count(*)::int count,min(p.status) status,min(p.outcome_code) outcome_code
         from provider_event_receipts r
         join provider_event_processing p on p.receipt_id=r.id
        where r.provider='stripe' and r.provider_event_id=$1`,
      [eventId],
    )).resolves.toMatchObject({
      rows: [{ count: 1, status: "failed_terminal", outcome_code: "security_envelope_mismatch" }],
    });
    await app.close();
  });
});
