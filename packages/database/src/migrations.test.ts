import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPublishedMigrationInventory,
  PUBLISHED_MIGRATIONS,
  resolveMigrationsFolder,
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
  it("keeps the canonical-name predicate executable only by its runtime writer and migrator", async () => {
    const sql = await readFile(join(migrationsFolder, "0008_account_name.sql"), "utf8");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.syntholo_account_name_is_canonical(text) TO\n  syntholo_member_api,\n  syntholo_migrator;",
    );
    expect(sql).not.toContain("syntholo_staff_api,\n  syntholo_member_api");
  });

  it("resolves migrations copied beside the bundled release artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "syntholo-migration-artifact-"));
    temporaryRoots.push(root);
    const bundledMigrations = join(root, "dist", "drizzle");
    await mkdir(bundledMigrations, { recursive: true });

    expect(resolveMigrationsFolder(
      pathToFileURL(join(root, "dist", "migrate.js")).href,
    )).toBe(bundledMigrations);
  });

  it("accepts only the exact ordered published journal and file hashes", () => {
    expect(assertPublishedMigrationInventory(migrationsFolder)).toEqual(
      PUBLISHED_MIGRATIONS,
    );
    expect(PUBLISHED_MIGRATIONS).toEqual([
      { idx: 0, when: 1786618800000, tag: "0001_foundation", hash: "bf3b66561107047f8c317d81bb561e9a29dc6207a14469a3ce588ec1f8ddc60c" },
      { idx: 1, when: 1786626000000, tag: "0002_roles_and_rls", hash: "6508044b65dcce22b5d9a25b954a40768b813d84f943247e59f6c6391cec60a4" },
      { idx: 2, when: 1786633200000, tag: "0003_staff_authentication", hash: "5b1e18eeeb392048ebcd7436622c60702694758b84edc209afb91ba861b8d9da" },
      { idx: 3, when: 1786640400000, tag: "0004_audit_and_jobs", hash: "717c39300253771cbd09070c2b75297c0bfd788290c522877bbbf7293c4a7ea1" },
      { idx: 4, when: 1786647600000, tag: "0005_entitlements", hash: "b61002f28e9970c63ea24a291ebcca8711bdd1f1a178b9ce09910243cc6683b5" },
      { idx: 5, when: 1786654800000, tag: "0006_runtime_readiness", hash: "6b465ae711125f441115f83dfbfe9bf63e92a74edd57190e357c10268adeafb5" },
      { idx: 6, when: 1786662000000, tag: "0007_runtime_contract", hash: "cc614367c67c41e46a22d951a5d413ce272e356b0fcd20d8ab0ab992d6727002" },
      { idx: 7, when: 1786669200000, tag: "0008_account_name", hash: "c0b495047a3ca6bdb1a24be475184a11c74037e255648a4d5bd73a5c68d598bb" },
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
