import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPublishedMigrationInventory,
  PUBLISHED_MIGRATIONS,
} from "./migrations.js";

const temporaryRoots: string[] = [];
const migrationsFolder = new URL("../drizzle", import.meta.url).pathname;

async function migrationFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "syntholo-migrations-"));
  temporaryRoots.push(root);
  await cp(migrationsFolder, root, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("published migration inventory", () => {
  it("accepts only the exact ordered published journal and file hashes", () => {
    expect(assertPublishedMigrationInventory(migrationsFolder)).toEqual(
      PUBLISHED_MIGRATIONS,
    );
    expect(PUBLISHED_MIGRATIONS.slice(0, 6).map(({ tag }) => tag)).toEqual([
      "0001_foundation",
      "0002_roles_and_rls",
      "0003_staff_authentication",
      "0004_audit_and_jobs",
      "0005_entitlements",
      "0006_runtime_readiness",
    ]);
  });

  it.each(["rewritten", "missing", "reordered"] as const)(
    "rejects a %s published migration inventory before Drizzle executes",
    async (mutation) => {
      const root = await migrationFixture();
      if (mutation === "rewritten") {
        const path = join(root, "0002_roles_and_rls.sql");
        await writeFile(path, `${await readFile(path, "utf8")}\n-- rewrite\n`, "utf8");
      } else if (mutation === "missing") {
        await rm(join(root, "0004_audit_and_jobs.sql"));
      } else {
        const journalPath = join(root, "meta/_journal.json");
        const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
          entries: unknown[];
        };
        [journal.entries[1], journal.entries[2]] = [journal.entries[2], journal.entries[1]];
        await writeFile(journalPath, JSON.stringify(journal), "utf8");
      }

      expect(() => assertPublishedMigrationInventory(root))
        .toThrow("PUBLISHED_MIGRATION_INVENTORY_INVALID");
    },
  );
});
