export { assertDatabaseCapability, createDatabase } from "./client.js";
export type { Database, DatabaseCapability, DatabaseConfig } from "./client.js";
export { selectMigrationDatabaseUrl } from "./migration-config.js";
export type { MigrationEnvironment } from "./migration-config.js";
export { migrateDatabase } from "./migrations.js";
export { AccountRepository } from "./repositories/accounts.js";
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
export { createUnitOfWork, withAccountScope } from "./unit-of-work.js";
export type {
  DatabaseTransaction,
  TransactionContext,
  UnitOfWork,
} from "./unit-of-work.js";
export {
  accounts,
  auditEvents,
  jobs,
  memberIdentities,
  memberships,
  outboxEvents,
  providerEventReceipts,
  staffIdentities,
  staffLoginAttempts,
  staffSessions,
} from "./schema/index.js";
