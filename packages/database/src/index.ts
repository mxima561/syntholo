export { assertDatabaseCapability, createDatabase } from "./client.js";
export type { Database, DatabaseCapability, DatabaseConfig } from "./client.js";
export { selectMigrationDatabaseUrl } from "./migration-config.js";
export type { MigrationEnvironment } from "./migration-config.js";
export { migrateDatabase } from "./migrations.js";
export { AccountRepository } from "./repositories/accounts.js";
export { AuditRepository } from "./repositories/audit.js";
export type { AuditEventInput } from "./repositories/audit.js";
export type {
  SystemActor,
  TrustedActor,
  TrustedTransactionMetadata,
} from "./repositories/context.js";
export { OutboxRepository } from "./repositories/outbox.js";
export {
  HandlerReceiptRepository,
  OutboxProcessorRepository,
  PermanentOutboxDispatchError,
} from "./repositories/outbox-processing.js";
export type {
  ClaimedOutboxEvent,
  HandlerReceiptClaim,
} from "./repositories/outbox-processing.js";
export { TransactionAccountRepository } from "./repositories/transaction-accounts.js";
export { JobRepository, nextAttempt } from "./repositories/jobs.js";
export type {
  ClaimedJob,
  ClassifiedJobFailure,
  JobErrorCode,
  JobInput,
  JobTransitionResult,
  LeaseExtensionResult,
} from "./repositories/jobs.js";
export {
  MemberIdentityRepository,
  StaffIdentityRepository,
  StaffLoginAttemptRepository,
  StaffSessionRepository,
} from "./repositories/auth.js";
export type {
  DatabaseLoginAttempt,
  DatabaseStaffIdentity,
  DatabaseStaffSession,
  DatabaseWorkosClaims,
  EncryptedDatabaseValue,
} from "./repositories/auth.js";
export type {
  AccountRecord,
  AccountScope,
} from "./repositories/accounts.js";
export { createUnitOfWork } from "./unit-of-work.js";
export type {
  TransactionContext,
  UnitOfWork,
} from "./unit-of-work.js";
export {
  accounts,
  auditEvents,
  eventHandlerReceipts,
  jobAttempts,
  jobs,
  memberIdentities,
  memberships,
  outboxEvents,
  providerEventReceipts,
  staffIdentities,
  staffLoginAttempts,
  staffSessions,
} from "./schema/index.js";
