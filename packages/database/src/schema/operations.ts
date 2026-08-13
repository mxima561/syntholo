import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./identity.js";

const timestampWithTimezone = (name: string) =>
  timestamp(name, { withTimezone: true });

const accountReference = () =>
  uuid("account_id").references(() => accounts.id, {
    onDelete: "restrict",
    onUpdate: "restrict",
  });

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    correlationId: uuid("correlation_id"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestampWithTimezone("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "audit_events_actor_type_check",
      sql`${table.actorType} in ('member', 'staff', 'system')`,
    ),
    check(
      "audit_events_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    index("audit_events_account_occurred_idx").on(
      table.accountId,
      table.occurredAt.desc().nullsLast(),
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    type: text("type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestampWithTimezone("available_at").notNull().defaultNow(),
    claimedAt: timestampWithTimezone("claimed_at"),
    publishedAt: timestampWithTimezone("published_at"),
    lastErrorCode: text("last_error_code"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "outbox_events_schema_version_check",
      sql`${table.schemaVersion} > 0`,
    ),
    check(
      "outbox_events_status_check",
      sql`${table.status} in ('pending', 'processing', 'published', 'dead_letter')`,
    ),
    check("outbox_events_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "outbox_events_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    index("outbox_events_claim_idx")
      .on(table.availableAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    queue: text("queue").notNull().default("default"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: timestampWithTimezone("run_at").notNull().defaultNow(),
    claimedAt: timestampWithTimezone("claimed_at"),
    workerId: text("worker_id"),
    completedAt: timestampWithTimezone("completed_at"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "jobs_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'dead_letter')`,
    ),
    check("jobs_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "jobs_max_attempts_check",
      sql`${table.maxAttempts} > 0 and ${table.attempts} <= ${table.maxAttempts}`,
    ),
    check(
      "jobs_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    index("jobs_claim_idx")
      .on(table.priority.desc().nullsLast(), table.runAt, table.id)
      .where(sql`${table.status} = 'queued'`),
  ],
);

export const providerEventReceipts = pgTable(
  "provider_event_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    status: text("status").notNull().default("received"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    receivedAt: timestampWithTimezone("received_at").notNull().defaultNow(),
    processedAt: timestampWithTimezone("processed_at"),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    unique("provider_event_receipts_provider_event_unique").on(
      table.provider,
      table.providerEventId,
    ),
    check(
      "provider_event_receipts_status_check",
      sql`${table.status} in ('received', 'processing', 'processed', 'failed')`,
    ),
    check(
      "provider_event_receipts_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    index("provider_event_receipts_status_received_idx").on(
      table.status,
      table.receivedAt,
    ),
  ],
);
