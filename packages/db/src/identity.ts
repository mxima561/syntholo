import type { DatabaseClient } from "./client";
import { withSystemScope } from "./scope";

export type IdentityMigration = {
  clerkId: string;
  neonUserId: string;
  appUserId: string;
  migratedAt: Date;
};

export const IDENTITY_MIGRATION_SQL = [
  `CREATE TABLE IF NOT EXISTS identity_migrations (
    clerk_id TEXT PRIMARY KEY,
    neon_user_id TEXT NOT NULL,
    app_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS identity_migrations_neon_idx ON identity_migrations (neon_user_id)`,
];

/**
 * Records Clerk → Neon Auth mapping without deleting clerk_id.
 * Existing rows stay intact until a later, verified cleanup.
 */
export async function recordIdentityMigration(
  input: { clerkId: string; neonUserId: string; appUserId: string },
  db?: DatabaseClient,
): Promise<void> {
  const run = async (sql: DatabaseClient) => {
    await sql`
      INSERT INTO identity_migrations (clerk_id, neon_user_id, app_user_id)
      VALUES (${input.clerkId}, ${input.neonUserId}, ${input.appUserId})
      ON CONFLICT (clerk_id) DO UPDATE SET
        neon_user_id = EXCLUDED.neon_user_id,
        app_user_id = EXCLUDED.app_user_id
    `;
  };
  if (db) {
    await run(db);
    return;
  }
  await withSystemScope(run);
}
