import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "./index.js";

const expectedColumns = {
  accounts: ["id", "name", "status", "created_at", "updated_at"],
  audit_events: [
    "id",
    "account_id",
    "actor_type",
    "actor_id",
    "action",
    "target_type",
    "target_id",
    "correlation_id",
    "payload",
    "occurred_at",
  ],
  jobs: [
    "id",
    "account_id",
    "queue",
    "type",
    "payload",
    "status",
    "priority",
    "attempts",
    "max_attempts",
    "run_at",
    "claimed_at",
    "worker_id",
    "completed_at",
    "last_error_code",
    "last_error_message",
    "created_at",
    "updated_at",
  ],
  member_identities: [
    "id",
    "account_id",
    "provider",
    "provider_user_id",
    "email",
    "created_at",
    "updated_at",
  ],
  memberships: [
    "id",
    "account_id",
    "member_identity_id",
    "role",
    "status",
    "created_at",
    "updated_at",
  ],
  outbox_events: [
    "id",
    "account_id",
    "type",
    "aggregate_id",
    "payload",
    "schema_version",
    "status",
    "attempts",
    "available_at",
    "claimed_at",
    "published_at",
    "last_error_code",
    "created_at",
  ],
  provider_event_receipts: [
    "id",
    "provider",
    "provider_event_id",
    "status",
    "payload",
    "received_at",
    "processed_at",
    "last_error_code",
  ],
  staff_identities: [
    "id",
    "provider",
    "provider_user_id",
    "email",
    "display_name",
    "role",
    "status",
    "permissions",
    "created_at",
    "updated_at",
  ],
} as const;

describe("foundation Drizzle schema", () => {
  it("declares the eight foundation table and column contracts", () => {
    const actual = Object.values(schema)
      .map((table) => [
        getTableName(table),
        Object.values(getTableColumns(table)).map((column) => column.name),
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    expect(actual).toEqual(Object.entries(expectedColumns));
  });
});
