import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client.js";

export const PUBLISHED_MIGRATIONS = Object.freeze([
  { idx: 0, when: 1786618800000, tag: "0001_foundation", hash: "bf3b66561107047f8c317d81bb561e9a29dc6207a14469a3ce588ec1f8ddc60c" },
  { idx: 1, when: 1786626000000, tag: "0002_roles_and_rls", hash: "6508044b65dcce22b5d9a25b954a40768b813d84f943247e59f6c6391cec60a4" },
  { idx: 2, when: 1786633200000, tag: "0003_staff_authentication", hash: "5b1e18eeeb392048ebcd7436622c60702694758b84edc209afb91ba861b8d9da" },
  { idx: 3, when: 1786640400000, tag: "0004_audit_and_jobs", hash: "717c39300253771cbd09070c2b75297c0bfd788290c522877bbbf7293c4a7ea1" },
  { idx: 4, when: 1786647600000, tag: "0005_entitlements", hash: "b61002f28e9970c63ea24a291ebcca8711bdd1f1a178b9ce09910243cc6683b5" },
  { idx: 5, when: 1786654800000, tag: "0006_runtime_readiness", hash: "6b465ae711125f441115f83dfbfe9bf63e92a74edd57190e357c10268adeafb5" },
  { idx: 6, when: 1786662000000, tag: "0007_runtime_contract", hash: "cc614367c67c41e46a22d951a5d413ce272e356b0fcd20d8ab0ab992d6727002" },
  { idx: 7, when: 1786669200000, tag: "0008_account_name", hash: "505693d0977b3cf51b156ac792605be7bf6e4a5c89c5ead8d4c728d1c298f513" },
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

export function migrateDatabase(database: Database): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder(import.meta.url);
  assertPublishedMigrationInventory(migrationsFolder);
  return migrate(database, {
    migrationsFolder,
  });
}
