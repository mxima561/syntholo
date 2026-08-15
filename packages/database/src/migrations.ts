import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Database } from "./client.js";

const MIGRATION_ADVISORY_LOCK = [1937339236, 1] as const;

export const PUBLISHED_MIGRATIONS = Object.freeze([
  { idx: 0, when: 1786618800000, tag: "0001_foundation", hash: "bf3b66561107047f8c317d81bb561e9a29dc6207a14469a3ce588ec1f8ddc60c" },
  { idx: 1, when: 1786626000000, tag: "0002_roles_and_rls", hash: "6508044b65dcce22b5d9a25b954a40768b813d84f943247e59f6c6391cec60a4" },
  { idx: 2, when: 1786633200000, tag: "0003_staff_authentication", hash: "5b1e18eeeb392048ebcd7436622c60702694758b84edc209afb91ba861b8d9da" },
  { idx: 3, when: 1786640400000, tag: "0004_audit_and_jobs", hash: "717c39300253771cbd09070c2b75297c0bfd788290c522877bbbf7293c4a7ea1" },
  { idx: 4, when: 1786647600000, tag: "0005_entitlements", hash: "b61002f28e9970c63ea24a291ebcca8711bdd1f1a178b9ce09910243cc6683b5" },
  { idx: 5, when: 1786654800000, tag: "0006_runtime_readiness", hash: "6b465ae711125f441115f83dfbfe9bf63e92a74edd57190e357c10268adeafb5" },
  { idx: 6, when: 1786662000000, tag: "0007_runtime_contract", hash: "cc614367c67c41e46a22d951a5d413ce272e356b0fcd20d8ab0ab992d6727002" },
  { idx: 7, when: 1786669200000, tag: "0008_account_name", hash: "505693d0977b3cf51b156ac792605be7bf6e4a5c89c5ead8d4c728d1c298f513" },
  { idx: 8, when: 1786676400000, tag: "0009_content", hash: "2cf79d036accf426172ab2249e690e34c17a8f145c8e2afa72bb8e3994425922" },
  { idx: 9, when: 1786683600000, tag: "0010_content_assets", hash: "65e621c5754cb490c50dff009854433815dae8ee3fd3a6410de9dea6080fcb43" },
  { idx: 10, when: 1786770000000, tag: "0011_learning", hash: "2e37ec9d4bfeee1ad0319ae81172fac4107a87c798bd2f0eed79eb75ee0e2ccf" },
  { idx: 11, when: 1786856400000, tag: "0012_implementation", hash: "dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9" },
] as const);

type Journal = Readonly<{
  dialect: string;
  entries: Array<Readonly<{
    breakpoints: boolean;
    idx: number;
    tag: string;
    version: string;
    when: number;
  }>>;
  version: string;
}>;

export function assertPublishedMigrationInventory(
  migrationsFolder: string,
): typeof PUBLISHED_MIGRATIONS {
  try {
    const journal = JSON.parse(
      readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8"),
    ) as Journal;
    const migrations = readMigrationFiles({ migrationsFolder });
    const actual = journal.entries.map((entry, index) => ({
      idx: entry.idx,
      when: entry.when,
      tag: entry.tag,
      hash: migrations[index]?.hash,
    }));
    if (
      journal.version !== "7"
      || journal.dialect !== "postgresql"
      || journal.entries.some((entry) => entry.version !== "7" || entry.breakpoints !== true)
      || JSON.stringify(actual) !== JSON.stringify(PUBLISHED_MIGRATIONS)
    ) throw new Error("mismatch");
    return PUBLISHED_MIGRATIONS;
  } catch {
    throw new Error("PUBLISHED_MIGRATION_INVENTORY_INVALID");
  }
}

export function resolveMigrationsFolder(moduleUrl: string): string {
  const candidates = [
    fileURLToPath(new URL("./drizzle", moduleUrl)),
    fileURLToPath(new URL("../drizzle", moduleUrl)),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (resolved === undefined) {
    throw new Error("PUBLISHED_MIGRATION_INVENTORY_INVALID");
  }
  return resolved;
}

export async function migrateDatabase(database: Database): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder(import.meta.url);
  assertPublishedMigrationInventory(migrationsFolder);
  const migrations = readMigrationFiles({ migrationsFolder });
  const client = await database.pool.connect();
  let transactionOpen = false;
  try {
    await client.query("select pg_advisory_lock($1::integer,$2::integer)", [
      ...MIGRATION_ADVISORY_LOCK,
    ]);
    await client.query("begin");
    transactionOpen = true;
    await client.query("create schema if not exists drizzle");
    await client.query(`create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )`);
    await client.query("commit");
    transactionOpen = false;

    const journal = await client.query<{ created_at: string; hash: string }>(
      "select hash,created_at::text created_at from drizzle.__drizzle_migrations order by created_at,id",
    );
    if (
      journal.rows.length > PUBLISHED_MIGRATIONS.length
      || journal.rows.some((row, index) => {
        const expected = PUBLISHED_MIGRATIONS[index];
        return expected === undefined
          || row.hash !== expected.hash
          || row.created_at !== String(expected.when);
      })
    ) throw new Error("PUBLISHED_MIGRATION_STATE_INVALID");

    for (let index = journal.rows.length; index < migrations.length; index += 1) {
      const migration = migrations[index];
      const published = PUBLISHED_MIGRATIONS[index];
      if (migration === undefined || published === undefined) {
        throw new Error("PUBLISHED_MIGRATION_INVENTORY_INVALID");
      }
      await client.query("begin");
      transactionOpen = true;
      try {
        if (published.tag === "0008_account_name") {
          await client.query("set constraints all immediate");
        }
        for (const statement of migration.sql) await client.query(statement);
        await client.query(
          "insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)",
          [migration.hash, migration.folderMillis],
        );
        await client.query("commit");
        transactionOpen = false;
      } catch (error) {
        await client.query("rollback");
        transactionOpen = false;
        throw error;
      }
    }
  } catch (error) {
    if (transactionOpen) await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.query("select pg_advisory_unlock($1::integer,$2::integer)", [
      ...MIGRATION_ADVISORY_LOCK,
    ]).catch(() => undefined);
    client.release();
  }
}
