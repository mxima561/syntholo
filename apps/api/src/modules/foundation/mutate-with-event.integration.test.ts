import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUnitOfWork,
  type UnitOfWork,
} from "@syntholo/database";
import {
  createTestDatabaseHarness,
  type TestDatabaseHarness,
} from "@syntholo/testing";
import { mutateWithEvent } from "./mutate-with-event.js";

const accountId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000002";
const correlationId = "10000000-0000-4000-8000-000000000003";
const now = new Date("2026-08-13T16:00:00.000Z");

function unitOfWork(harness: TestDatabaseHarness): UnitOfWork {
  return createUnitOfWork(harness.database, {
    accountId,
    actor: {
      accountId,
      actorId,
      authenticatedAt: now,
      clerkUserId: "clerk_ref_1",
      kind: "member",
      membershipId: "10000000-0000-4000-8000-000000000004",
      role: "owner",
    },
    clock: { now: () => now },
    correlationId,
  });
}

function records(eventId = randomUUID()) {
  return {
    audit: {
      action: "account_name_changed",
      payload: { changedFields: ["name"] },
      targetId: accountId,
      targetType: "account",
    },
    event: {
      aggregateId: accountId,
      eventId,
      payload: { changedFields: ["name"] },
      type: "foundation.account_name_changed.v1",
    },
  } as const;
}

async function operationCounts(harness: TestDatabaseHarness) {
  const result = await harness.database.pool.query<{
    audit_count: string;
    outbox_count: string;
  }>(
    `select
       (select count(*)::text from audit_events) as audit_count,
       (select count(*)::text from outbox_events) as outbox_count`,
  );
  return result.rows[0];
}

describe("mutateWithEvent", () => {
  let harness: TestDatabaseHarness;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
  });

  beforeEach(async () => {
    await harness.reset();
    await harness.factories.account(harness.database, {
      id: accountId,
      name: "Before",
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("commits the mutation, trusted audit provenance, and canonical outbox event together", async () => {
    const eventId = "10000000-0000-4000-8000-000000000005";

    const result = await mutateWithEvent(
      unitOfWork(harness),
      records(eventId),
      async (transaction) => {
        return transaction.accounts.rename("After");
      },
    );

    expect(result).toBe("After");
    const persisted = await harness.database.pool.query(
      `select a.actor_type, a.actor_id, a.account_id,
              a.correlation_id, (a.occurred_at at time zone 'UTC')::text as occurred_at,
              o.event_id, o.type, o.aggregate_id, o.account_id as event_account_id,
              (o.occurred_at at time zone 'UTC')::text as event_occurred_at, o.schema_version,
              o.payload
       from audit_events a cross join outbox_events o`,
    );
    expect(persisted.rows).toEqual([{
      account_id: accountId,
      actor_id: actorId,
      actor_type: "member",
      aggregate_id: accountId,
      correlation_id: correlationId,
      event_account_id: accountId,
      event_id: eventId,
      event_occurred_at: "2026-08-13 16:00:00",
      occurred_at: "2026-08-13 16:00:00",
      payload: { changedFields: ["name"] },
      schema_version: 1,
      type: "foundation.account_name_changed.v1",
    }]);
  });

  it("keeps all three writes invisible until the physical transaction commits", async () => {
    let release!: () => void;
    let written!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const writesReady = new Promise<void>((resolve) => { written = resolve; });
    const uow = unitOfWork(harness);

    const pending = uow.transaction(async (transaction) => {
      await transaction.accounts.rename("Pending");
      await transaction.audit.append(records().audit);
      await transaction.outbox.enqueue(
        transaction.outbox.create(records().event),
      );
      written();
      await blocked;
    });
    await writesReady;

    expect(await operationCounts(harness)).toEqual({
      audit_count: "0",
      outbox_count: "0",
    });
    const beforeCommit = await harness.database.pool.query<{ name: string }>(
      "select name from accounts where id = $1",
      [accountId],
    );
    expect(beforeCommit.rows[0]?.name).toBe("Before");

    release();
    await pending;
    expect(await operationCounts(harness)).toEqual({
      audit_count: "1",
      outbox_count: "1",
    });
  });

  it("rolls back the mutation when the mutation throws", async () => {
    await expect(mutateWithEvent(
      unitOfWork(harness),
      records(),
      async (transaction) => {
        await transaction.accounts.rename("Must roll back");
        throw new Error("EXPECTED_ROLLBACK");
      },
    )).rejects.toThrow("EXPECTED_ROLLBACK");

    expect(await operationCounts(harness)).toEqual({
      audit_count: "0",
      outbox_count: "0",
    });
    const account = await harness.database.pool.query<{ name: string }>(
      "select name from accounts where id = $1",
      [accountId],
    );
    expect(account.rows[0]?.name).toBe("Before");
  });

  it("rolls back the mutation when audit validation fails", async () => {
    const invalid = {
      ...records(),
      audit: { ...records().audit, payload: { transcript: "redacted" } },
    };

    await expect(mutateWithEvent(
      unitOfWork(harness),
      invalid,
      async (transaction) => {
        await transaction.accounts.rename("Must roll back");
      },
    )).rejects.toThrow("PERSISTED_PAYLOAD_INVALID");

    const account = await harness.database.pool.query<{ name: string }>(
      "select name from accounts where id = $1",
      [accountId],
    );
    expect(account.rows[0]?.name).toBe("Before");
    expect(await operationCounts(harness)).toEqual({
      audit_count: "0",
      outbox_count: "0",
    });
  });

  it("rolls back the mutation and audit on a conflicting event identity", async () => {
    const eventId = "10000000-0000-4000-8000-000000000006";
    const uow = unitOfWork(harness);
    await uow.transaction(async (transaction) => {
      await transaction.outbox.enqueue(transaction.outbox.create(records(eventId).event));
    });

    await expect(mutateWithEvent(
      uow,
      {
        ...records(eventId),
        event: { ...records(eventId).event, payload: { status: "changed" } },
      },
      async (transaction) => {
        await transaction.accounts.rename("Must roll back");
      },
    )).rejects.toThrow("OUTBOX_EVENT_CONFLICT");

    const account = await harness.database.pool.query<{ name: string }>(
      "select name from accounts where id = $1",
      [accountId],
    );
    expect(account.rows[0]?.name).toBe("Before");
    expect(await operationCounts(harness)).toEqual({
      audit_count: "0",
      outbox_count: "1",
    });
  });
});
