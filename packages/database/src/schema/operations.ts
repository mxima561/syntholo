import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    correlationId: uuid("correlation_id").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestampWithTimezone("occurred_at").notNull(),
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
    check("audit_events_actor_id_length_check", sql`octet_length(${table.actorId}) between 1 and 255`),
    check("audit_events_action_length_check", sql`octet_length(${table.action}) between 1 and 255`),
    check("audit_events_target_type_length_check", sql`octet_length(${table.targetType}) between 1 and 255`),
    check("audit_events_target_id_length_check", sql`${table.targetId} is null or octet_length(${table.targetId}) between 1 and 255`),
    check("audit_events_payload_size_check", sql`octet_length(${table.payload}::text) <= 16384`),
    index("audit_events_account_occurred_idx").on(
      table.accountId,
      table.occurredAt.desc().nullsLast(),
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    legacyId: uuid("id").notNull().defaultRandom(),
    eventId: uuid("event_id").primaryKey(),
    accountId: accountReference(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    type: text("type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    occurredAt: timestampWithTimezone("occurred_at").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(10),
    availableAt: timestampWithTimezone("available_at").notNull().defaultNow(),
    claimedAt: timestampWithTimezone("claimed_at"),
    workerId: text("worker_id"),
    leaseExpiresAt: timestampWithTimezone("lease_expires_at"),
    claimToken: uuid("claim_token"),
    claimGeneration: integer("claim_generation").notNull().default(0),
    publishedAt: timestampWithTimezone("published_at"),
    deadLetteredAt: timestampWithTimezone("dead_lettered_at"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("outbox_events_legacy_id_unique").on(table.legacyId),
    check("outbox_events_identity_check", sql`${table.legacyId} = ${table.eventId}`),
    check(
      "outbox_events_schema_version_check",
      sql`${table.schemaVersion} = 1`,
    ),
    check("outbox_events_actor_type_check", sql`${table.actorType} in ('member', 'staff', 'system')`),
    check("outbox_events_actor_id_length_check", sql`octet_length(${table.actorId}) between 1 and 255`),
    check(
      "outbox_events_status_check",
      sql`${table.status} in ('pending', 'processing', 'published', 'dead_letter')`,
    ),
    check("outbox_events_attempts_check", sql`${table.attempts} >= 0`),
    check("outbox_events_attempt_bounds_check", sql`${table.attempts} >= 0 and ${table.maxAttempts} between 1 and 100 and ${table.attempts} <= ${table.maxAttempts}`),
    check("outbox_events_claim_generation_check", sql`${table.claimGeneration} >= 0`),
    check("outbox_events_type_length_check", sql`octet_length(${table.type}) between 1 and 255`),
    check("outbox_events_aggregate_id_length_check", sql`octet_length(${table.aggregateId}) between 1 and 255`),
    check("outbox_events_worker_id_length_check", sql`${table.workerId} is null or octet_length(${table.workerId}) between 1 and 128`),
    check("outbox_events_error_code_length_check", sql`${table.lastErrorCode} is null or octet_length(${table.lastErrorCode}) between 1 and 64`),
    check("outbox_events_error_message_length_check", sql`${table.lastErrorMessage} is null or octet_length(${table.lastErrorMessage}) between 1 and 255`),
    check("outbox_events_payload_size_check", sql`octet_length(${table.payload}::text) <= 65536`),
    check("outbox_events_state_fields_check", sql`(${table.status} = 'pending' and ${table.workerId} is null and ${table.claimedAt} is null and ${table.leaseExpiresAt} is null and ${table.claimToken} is null and ${table.publishedAt} is null and ${table.deadLetteredAt} is null) or (${table.status} = 'processing' and ${table.workerId} is not null and ${table.claimedAt} is not null and ${table.leaseExpiresAt} is not null and ${table.leaseExpiresAt} > ${table.claimedAt} and ${table.claimToken} is not null and ${table.publishedAt} is null and ${table.deadLetteredAt} is null) or (${table.status} = 'published' and ${table.publishedAt} is not null and ${table.publishedAt} >= ${table.occurredAt} and ${table.deadLetteredAt} is null and ${table.leaseExpiresAt} is null and ${table.claimToken} is null) or (${table.status} = 'dead_letter' and ${table.deadLetteredAt} is not null and ${table.deadLetteredAt} >= ${table.occurredAt} and ${table.publishedAt} is null and ${table.leaseExpiresAt} is null and ${table.claimToken} is null)`),
    check(
      "outbox_events_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    index("outbox_events_claim_idx")
      .on(table.availableAt, table.createdAt, table.eventId)
      .where(sql`${table.status} in ('pending', 'processing')`),
    index("outbox_events_recovery_idx")
      .on(table.leaseExpiresAt, table.eventId)
      .where(sql`${table.status} = 'processing'`),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    sourceActorType: text("source_actor_type").notNull(),
    sourceActorId: text("source_actor_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    queue: text("queue").notNull().default("default"),
    type: text("type").notNull(),
    idempotencyKey: text("idempotency_key").notNull()
      .default(sql`gen_random_uuid()::text`)
      .unique(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: timestampWithTimezone("run_at").notNull().defaultNow(),
    claimedAt: timestampWithTimezone("claimed_at"),
    workerId: text("worker_id"),
    leaseExpiresAt: timestampWithTimezone("lease_expires_at"),
    claimToken: uuid("claim_token"),
    claimGeneration: integer("claim_generation").notNull().default(0),
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
    check("jobs_source_actor_type_check", sql`${table.sourceActorType} in ('member', 'staff', 'system')`),
    check("jobs_source_actor_id_length_check", sql`octet_length(${table.sourceActorId}) between 1 and 255`),
    check("jobs_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "jobs_max_attempts_check",
      sql`${table.maxAttempts} > 0 and ${table.attempts} <= ${table.maxAttempts}`,
    ),
    check(
      "jobs_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    check("jobs_idempotency_key_length_check", sql`octet_length(${table.idempotencyKey}) between 1 and 512`),
    check("jobs_queue_length_check", sql`octet_length(${table.queue}) between 1 and 64`),
    check("jobs_type_length_check", sql`octet_length(${table.type}) between 1 and 255`),
    check("jobs_worker_id_length_check", sql`${table.workerId} is null or octet_length(${table.workerId}) between 1 and 128`),
    check("jobs_claim_generation_check", sql`${table.claimGeneration} >= 0`),
    check("jobs_priority_check", sql`${table.priority} between -1000 and 1000`),
    check("jobs_max_attempts_upper_check", sql`${table.maxAttempts} between 1 and 100`),
    check("jobs_error_code_length_check", sql`${table.lastErrorCode} is null or octet_length(${table.lastErrorCode}) between 1 and 64`),
    check("jobs_error_message_length_check", sql`${table.lastErrorMessage} is null or octet_length(${table.lastErrorMessage}) between 1 and 255`),
    check("jobs_payload_size_check", sql`octet_length(${table.payload}::text) <= 65536`),
    check("jobs_state_fields_check", sql`(${table.status} = 'queued' and ${table.workerId} is null and ${table.claimedAt} is null and ${table.leaseExpiresAt} is null and ${table.claimToken} is null and ${table.completedAt} is null) or (${table.status} = 'running' and ${table.workerId} is not null and ${table.claimedAt} is not null and ${table.leaseExpiresAt} is not null and ${table.leaseExpiresAt} > ${table.claimedAt} and ${table.claimToken} is not null and ${table.completedAt} is null) or (${table.status} in ('completed', 'dead_letter') and ${table.completedAt} is not null and ${table.leaseExpiresAt} is null and ${table.claimToken} is null and (${table.claimedAt} is null or ${table.completedAt} >= ${table.claimedAt}))`),
    index("jobs_claim_idx")
      .on(table.priority.desc().nullsLast(), table.runAt, table.id)
      .where(sql`${table.status} in ('queued', 'running')`),
    index("jobs_recovery_idx")
      .on(table.leaseExpiresAt, table.id)
      .where(sql`${table.status} = 'running'`),
  ],
);

export const jobAttempts = pgTable(
  "job_attempts",
  {
    jobId: uuid("job_id").notNull().references(() => jobs.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    accountId: accountReference(),
    attempt: integer("attempt").notNull(),
    claimGeneration: integer("claim_generation").notNull(),
    claimToken: uuid("claim_token").notNull().unique(),
    workerId: text("worker_id").notNull(),
    startedAt: timestampWithTimezone("started_at").notNull(),
    leaseExpiresAt: timestampWithTimezone("lease_expires_at").notNull(),
    finishedAt: timestampWithTimezone("finished_at"),
    outcome: text("outcome").notNull().default("running"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.attempt, table.claimGeneration] }),
    check("job_attempts_attempt_check", sql`${table.attempt} > 0`),
    check("job_attempts_generation_check", sql`${table.claimGeneration} > 0`),
    check("job_attempts_worker_id_check", sql`octet_length(${table.workerId}) between 1 and 128`),
    check("job_attempts_outcome_check", sql`${table.outcome} in ('running', 'completed', 'retry', 'dead_letter', 'lease_expired')`),
    check("job_attempts_error_code_check", sql`${table.errorCode} is null or octet_length(${table.errorCode}) between 1 and 64`),
    check("job_attempts_error_message_check", sql`${table.errorMessage} is null or octet_length(${table.errorMessage}) between 1 and 255`),
    check("job_attempts_time_check", sql`${table.leaseExpiresAt} > ${table.startedAt} and (${table.finishedAt} is null or ${table.finishedAt} >= ${table.startedAt})`),
    check("job_attempts_finish_check", sql`(${table.outcome} = 'running' and ${table.finishedAt} is null) or (${table.outcome} <> 'running' and ${table.finishedAt} is not null)`),
    index("job_attempts_account_started_idx").on(table.accountId, table.startedAt.desc()),
  ],
);

export const eventHandlerReceipts = pgTable(
  "event_handler_receipts",
  {
    handlerName: text("handler_name").notNull(),
    eventId: uuid("event_id").notNull().references(() => outboxEvents.eventId, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    jobId: uuid("job_id").notNull().references(() => jobs.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    accountId: accountReference(),
    status: text("status").notNull(),
    workerId: text("worker_id").notNull(),
    attempt: integer("attempt").notNull(),
    claimGeneration: integer("claim_generation").notNull(),
    claimToken: uuid("claim_token").notNull().unique(),
    leaseExpiresAt: timestampWithTimezone("lease_expires_at"),
    startedAt: timestampWithTimezone("started_at").notNull(),
    completedAt: timestampWithTimezone("completed_at"),
    updatedAt: timestampWithTimezone("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.handlerName, table.eventId] }),
    check("event_handler_receipts_handler_check", sql`octet_length(${table.handlerName}) between 1 and 128`),
    check("event_handler_receipts_worker_check", sql`octet_length(${table.workerId}) between 1 and 128`),
    check("event_handler_receipts_status_check", sql`${table.status} in ('processing', 'retryable', 'completed')`),
    check("event_handler_receipts_attempt_check", sql`${table.attempt} > 0`),
    check("event_handler_receipts_generation_check", sql`${table.claimGeneration} > 0`),
    check("event_handler_receipts_state_check", sql`(${table.status} = 'processing' and ${table.leaseExpiresAt} is not null and ${table.leaseExpiresAt} > ${table.startedAt} and ${table.completedAt} is null) or (${table.status} = 'retryable' and ${table.leaseExpiresAt} is null and ${table.completedAt} is null) or (${table.status} = 'completed' and ${table.leaseExpiresAt} is null and ${table.completedAt} is not null and ${table.completedAt} >= ${table.startedAt})`),
    check("event_handler_receipts_updated_check", sql`${table.updatedAt} >= ${table.startedAt}`),
    index("event_handler_receipts_recovery_idx")
      .on(table.leaseExpiresAt, table.handlerName, table.eventId)
      .where(sql`${table.status} = 'processing'`),
  ],
);

export const providerEventReceipts = pgTable(
  "provider_event_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type"),
    livemode: boolean("livemode"),
    apiVersion: text("api_version"),
    providerCreatedAt: timestamp("provider_created_at", { precision: 3, withTimezone: true }),
    dataObjectType: text("data_object_type"),
    dataObjectId: text("data_object_id"),
    receiverStripeAccountId: text("receiver_stripe_account_id"),
    eventAccount: text("event_account"),
    eventContext: text("event_context"),
    rawBodySha256: text("raw_body_sha256"),
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
    unique("provider_event_receipts_fulfillment_owner_unique").on(
      table.id,
      table.provider,
      table.receiverStripeAccountId,
    ),
    check(
      "provider_event_receipts_status_check",
      sql`${table.status} in ('received', 'processing', 'processed', 'failed')`,
    ),
    check(
      "provider_event_receipts_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    check(
      "provider_event_receipts_stripe_envelope_check",
      sql`${table.provider}<>'stripe' or (${table.eventType} is not null and octet_length(${table.eventType}) between 1 and 128 and ${table.livemode} is not null and (${table.apiVersion} is null or octet_length(${table.apiVersion}) between 1 and 64) and ${table.providerCreatedAt} is not null and ${table.providerCreatedAt}=date_trunc('milliseconds',${table.providerCreatedAt}) and ${table.dataObjectType} is not null and octet_length(${table.dataObjectType}) between 1 and 128 and ${table.dataObjectId} is not null and octet_length(${table.dataObjectId}) between 1 and 255 and ${table.receiverStripeAccountId} is not null and octet_length(${table.receiverStripeAccountId}) between 1 and 255 and (${table.eventAccount} is null or octet_length(${table.eventAccount}) between 1 and 255) and (${table.eventContext} is null or octet_length(${table.eventContext}) between 1 and 255) and ${table.rawBodySha256}~'^[0-9a-f]{64}$' and ${table.status}='received' and ${table.payload}='{}'::jsonb)`,
    ),
    index("provider_event_receipts_status_received_idx").on(
      table.status,
      table.receivedAt,
    ),
  ],
);
