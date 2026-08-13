export { createDatabase } from "./client.js";
export type { Database, DatabaseConfig } from "./client.js";
export { selectMigrationDatabaseUrl } from "./migration-config.js";
export type { MigrationEnvironment } from "./migration-config.js";
export { migrateDatabase } from "./migrations.js";
export { AccountRepository } from "./repositories/accounts.js";
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
} from "./schema/index.js";
