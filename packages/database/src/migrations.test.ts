import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPublishedMigrationInventory,
  migrateDatabase,
  PUBLISHED_MIGRATIONS,
  resolveMigrationsFolder,
} from "./migrations.js";
import type { Database } from "./client.js";

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
  it("reserves 0014 as journal index thirteen after the immutable certificate migration", () => {
    expect(PUBLISHED_MIGRATIONS.at(-1)).toMatchObject({
      idx: 13,
      when: 1787029200000,
      tag: "0014_commerce_catalog",
    });
  });

  it("serializes atomic migrations and makes only 0008 constraints immediate", async () => {
    const queries: string[] = [];
    let released = false;
    const client = {
      async query(statement: string) {
        queries.push(statement);
        if (statement.startsWith("select hash,created_at::text")) {
          return {
            rows: PUBLISHED_MIGRATIONS.slice(0, 7).map((migration) => ({
              created_at: String(migration.when),
              hash: migration.hash,
            })),
          };
        }
        return { rows: [] };
      },
      release() {
        released = true;
      },
    };
    const database = {
      pool: { connect: async () => client },
    } as unknown as Database;

    await migrateDatabase(database);

    expect(queries[0]).toBe("select pg_advisory_lock($1::integer,$2::integer)");
    expect(queries.at(-1)).toBe("select pg_advisory_unlock($1::integer,$2::integer)");
    expect(queries.filter((query) => query === "begin")).toHaveLength(8);
    expect(queries.filter((query) => query === "commit")).toHaveLength(8);
    expect(queries.filter((query) => query === "set constraints all immediate"))
      .toHaveLength(1);
    const immediate = queries.indexOf("set constraints all immediate");
    expect(queries[immediate - 1]).toBe("begin");
    expect(queries.filter((query) => query.startsWith(
      "insert into drizzle.__drizzle_migrations",
    ))).toHaveLength(7);
    expect(released).toBe(true);
  });

  it("rolls back a failed migration without journaling it and releases the lock", async () => {
    const queries: string[] = [];
    let released = false;
    const client = {
      async query(statement: string) {
        queries.push(statement);
        if (statement.startsWith("select hash,created_at::text")) {
          return {
            rows: PUBLISHED_MIGRATIONS.slice(0, 9).map((migration) => ({
              created_at: String(migration.when),
              hash: migration.hash,
            })),
          };
        }
        if (statement.startsWith("CREATE TABLE public.content_media_assets")) {
          throw new Error("TEST_MIGRATION_FAILED");
        }
        return { rows: [] };
      },
      release() {
        released = true;
      },
    };
    const database = {
      pool: { connect: async () => client },
    } as unknown as Database;

    await expect(migrateDatabase(database)).rejects.toThrow("TEST_MIGRATION_FAILED");

    expect(queries).toContain("rollback");
    expect(queries.some((query) => query.startsWith(
      "insert into drizzle.__drizzle_migrations",
    ))).toBe(false);
    expect(queries.at(-1)).toBe("select pg_advisory_unlock($1::integer,$2::integer)");
    expect(released).toBe(true);
  });

  it("fails the content preview command closed until authoritative publication derivation exists", async () => {
    const sql = await readFile(join(migrationsFolder, "0009_content.sql"), "utf8");
    const functionStart = sql.indexOf("CREATE FUNCTION public.syntholo_content_create_preview_v1");
    const functionEnd = sql.indexOf(
      "REVOKE ALL ON FUNCTION public.syntholo_content_create_preview_v1",
      functionStart,
    );
    const previewCommand = sql.slice(functionStart, functionEnd);

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    expect(previewCommand).toContain("RAISE EXCEPTION 'CONTENT_PUBLICATION_PIPELINE_INCOMPLETE'");
    expect(previewCommand.indexOf("CONTENT_PUBLICATION_PIPELINE_INCOMPLETE"))
      .toBeLessThan(previewCommand.indexOf("INSERT INTO public.content_previews"));
  });

  it("authorizes the exact active learning access before replaying a completion receipt", async () => {
    const sql = await readFile(join(migrationsFolder, "0011_learning.sql"), "utf8");
    const functionStart = sql.indexOf("CREATE FUNCTION public.syntholo_learning_complete_lesson_v1");
    const functionEnd = sql.indexOf(
      "REVOKE ALL ON FUNCTION public.syntholo_learning_complete_lesson_v1",
      functionStart,
    );
    const command = sql.slice(functionStart, functionEnd);

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const activeAccess = command.indexOf("aca.status='active'");
    const replay = command.indexOf("IF receipt.status='completed' THEN RETURN receipt.response; END IF;");
    expect(activeAccess).toBeGreaterThanOrEqual(0);
    expect(activeAccess).toBeLessThan(replay);
  });

  it("keeps implementation drafts shape-valid while reserving completeness for final and live state", async () => {
    const sql = await readFile(join(migrationsFolder, "0012_implementation.sql"), "utf8");

    expect(sql).toContain(
      "implementation_workflows_arrays_check CHECK(public.syntholo_implementation_text_array_valid_v1(approved_tools,25,255) AND public.syntholo_implementation_text_array_valid_v1(steps,25,2000))",
    );
    expect(sql).toContain(
      "public.syntholo_implementation_text_array_complete_v1(approved_tools)",
    );
    expect(sql).toContain(
      "public.syntholo_implementation_text_array_complete_v1(steps)",
    );
    expect(sql).toContain("syntholo_implementation_workflow_content_match_v1");
    expect(sql).toContain("IMPLEMENTATION_WORKFLOW_CONTENT_MISMATCH");
  });

  it("claims an implementation idempotency key before inserting its receipt and revalidates locked access", async () => {
    const sql = await readFile(join(migrationsFolder, "0012_implementation.sql"), "utf8");
    const start = sql.indexOf("CREATE FUNCTION public.syntholo_implementation_save_version_v1");
    const end = sql.indexOf("REVOKE ALL ON FUNCTION public.syntholo_implementation_save_version_v1", start);
    const command = sql.slice(start, end);

    const authorization = command.indexOf("aca.status='active'");
    const claim = command.indexOf("pg_try_advisory_xact_lock");
    const receiptInsert = command.indexOf("INSERT INTO public.api_command_receipts");
    const lockedRevalidation = command.indexOf("FOR SHARE OF m,e,aca");
    const replay = command.indexOf("IF receipt.status='completed' THEN RETURN receipt.response; END IF;");
    const versionInsert = command.indexOf("INSERT INTO public.implementation_artifact_versions");

    expect(authorization).toBeGreaterThanOrEqual(0);
    expect(claim).toBeGreaterThan(authorization);
    expect(receiptInsert).toBeGreaterThan(claim);
    expect(lockedRevalidation).toBeGreaterThan(authorization);
    expect(claim).toBeGreaterThan(lockedRevalidation);
    expect(replay).toBeGreaterThan(lockedRevalidation);
    expect(versionInsert).toBeGreaterThan(lockedRevalidation);

    for (const signature of [
      "syntholo_implementation_get_v1",
      "syntholo_implementation_versions_v1",
    ]) {
      const stableStart = sql.indexOf(`CREATE FUNCTION public.${signature}`);
      const stableEnd = sql.indexOf(`REVOKE ALL ON FUNCTION public.${signature}`, stableStart);
      const stableBody = sql.slice(stableStart, stableEnd);
      expect(stableBody).not.toContain("FOR SHARE");
      expect(stableBody).not.toContain("FOR UPDATE");
    }
  });

  it("publishes exact implementation indexes, receipt uniqueness, immutable roots, and catalog attestation", async () => {
    const sql = await readFile(join(migrationsFolder, "0012_implementation.sql"), "utf8");

    expect(sql).toContain("CONSTRAINT implementation_versions_source_command_receipt_id_unique UNIQUE(source_command_receipt_id)");
    expect(sql).toContain("implementation_versions_history_idx ON public.implementation_artifact_versions(artifact_id,created_at DESC,id DESC)");
    expect(sql).toContain("course_completions_implementation_lookup_idx ON public.course_completions(account_id,course_id,completed_at,id)");
    expect(sql).toContain("implementation_artifacts_delete_immutable BEFORE DELETE");
    expect(sql).toContain("pg_get_constraintdef");
    expect(sql).toContain("pg_get_indexdef");
    expect(sql).toContain("pg_get_expr(p.polqual,p.polrelid)");
    expect(sql).toContain("pg_get_functiondef");
    expect(sql).toContain("expected_checks(table_name,constraint_name,definition)");
    expect(sql).not.toContain("required_token");
    expect(sql).toContain("e.definition<>a.definition");
  });

  it("forward-closes system capability attestation around the exact implementation seed command", async () => {
    const sql = await readFile(join(migrationsFolder, "0012_implementation.sql"), "utf8");
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.syntholo_attest_runtime_capability");
    const end = sql.indexOf("WITH source AS (", start);
    const attestation = sql.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(attestation).toContain("'syntholo_implementation_seed_workspace_v1(uuid)'");
    expect(attestation).toContain("'syntholo_implementation_readiness_v1()'");
    expect(attestation.match(/syntholo_implementation_seed_workspace_v1\(uuid\)/gu)).toHaveLength(1);
    expect(attestation.match(/syntholo_implementation_readiness_v1\(\)/gu)).toHaveLength(1);
    const systemGrants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION public\.(syntholo_implementation_[^(;]+\([^;]*?\)) TO ([^;]+);/gu)]
      .filter((match) => match[2]?.includes("syntholo_system_api"))
      .map((match) => match[1])
      .sort();
    expect(systemGrants).toEqual([
      "syntholo_implementation_readiness_v1()",
      "syntholo_implementation_seed_workspace_v1(uuid)",
    ]);
    expect(sql).toContain("expected_runtime_attestation(signature,body_hash)");
    expect(sql).toContain("actual_body_hash=body_hash) FROM runtime_attestation");
  });

  it("binds implementation recompute to the exact member-authored learning event", async () => {
    const sql = await readFile(join(migrationsFolder, "0012_implementation.sql"), "utf8");
    const start = sql.indexOf("CREATE FUNCTION public.syntholo_implementation_record_course_completion_v1");
    const end = sql.indexOf("REVOKE ALL ON FUNCTION public.syntholo_implementation_record_course_completion_v1", start);
    const command = sql.slice(start, end);

    expect(command).toContain("o.actor_type='member'");
    expect(command).toContain("source_event.actor_id=member_identity.member_identity_id::text");
    expect(command).toContain("source_event.correlation_id");
  });

  it("selects the workflow portfolio head without applying unsupported aggregates to UUIDs", async () => {
    const sql = await readFile(join(migrationsFolder, "0012_implementation.sql"), "utf8");
    const start = sql.indexOf("CREATE FUNCTION public.syntholo_implementation_recompute_completion_v1");
    const end = sql.indexOf("REVOKE ALL ON FUNCTION public.syntholo_implementation_recompute_completion_v1", start);
    const command = sql.slice(start, end);

    expect(command).not.toMatch(/(?:min|max)\((?:a|v)\.id\)/u);
    expect(command).toContain("SELECT a.id,v.id INTO portfolio_artifact,portfolio_version");
    expect(command).toContain("a.kind='workflow_portfolio'");
  });

  it("closes the server-derived lesson hash input before applying its encoding", async () => {
    const sql = await readFile(join(migrationsFolder, "0011_learning.sql"), "utf8");
    const functionStart = sql.indexOf("CREATE FUNCTION public.syntholo_lesson_draft_hash_v1");
    const functionEnd = sql.indexOf(
      "REVOKE ALL ON FUNCTION public.syntholo_lesson_draft_hash_v1",
      functionStart,
    );
    const hashFunction = sql.slice(functionStart, functionEnd);

    expect(hashFunction).toContain("archived_at IS NULL),'[]'::jsonb))),'UTF8')),'hex')");
    expect(hashFunction).not.toContain("archived_at IS NULL),'[]'::jsonb)))),'UTF8')");
  });

  it("attests OLD and NEW trigger predicates through PostgreSQL trigger definitions", async () => {
    for (const migration of ["0011_learning.sql", "0012_implementation.sql"]) {
      const sql = await readFile(join(migrationsFolder, migration), "utf8");

      expect(sql).toContain("pg_get_triggerdef(t.oid,true)");
      expect(sql).not.toContain("pg_get_expr(t.tgqual,t.tgrelid)");
    }
  });

  it("normalizes PostgreSQL zero-based int2vector index options before exact equality", async () => {
    const sql = await readFile(join(migrationsFolder, "0012_implementation.sql"), "utf8");
    expect(sql).toContain(
      "ARRAY(SELECT option FROM unnest(i.indoption::smallint[]) WITH ORDINALITY option_value(option,ordinal) ORDER BY ordinal) index_options",
    );
    expect(sql).not.toContain("i.indoption::smallint[] index_options");
  });

  it("matches PostgreSQL's schema-qualified deparse for implementation CHECK helpers", async () => {
    const sql = await readFile(join(migrationsFolder, "0012_implementation.sql"), "utf8");
    const start = sql.indexOf("expected_checks(table_name,constraint_name,definition)");
    const end = sql.indexOf("), actual_checks AS", start);
    const expectedChecks = sql.slice(start, end);
    for (const helper of [
      "public.syntholo_implementation_content_valid_v1",
      "public.syntholo_canonical_jsonb_text_v1",
      "public.syntholo_implementation_text_valid_v1",
      "public.syntholo_implementation_text_array_valid_v1",
      "public.syntholo_implementation_text_complete_v1",
      "public.syntholo_implementation_text_array_complete_v1",
    ]) expect(expectedChecks).toContain(helper);
    expect(expectedChecks).not.toMatch(/(?<!public\.)syntholo_(?:implementation_(?:content_valid|text_valid|text_array_valid|text_complete|text_array_complete)|canonical_jsonb_text)_v1/u);
  });

  it("qualifies completion receipt persistence away from PL/pgSQL variable ambiguity", async () => {
    const sql = await readFile(join(migrationsFolder, "0011_learning.sql"), "utf8");
    const functionStart = sql.indexOf("CREATE FUNCTION public.syntholo_learning_complete_lesson_v1");
    const functionEnd = sql.indexOf("REVOKE ALL ON FUNCTION public.syntholo_learning_complete_lesson_v1", functionStart);
    const command = sql.slice(functionStart, functionEnd);

    expect(command).toContain("UPDATE public.api_command_receipts AS command_receipt SET");
    expect(command).toContain("response=response_payload");
    expect(command).not.toContain("response=response,");
  });

  it("qualifies both staff publication receipt writes away from PL/pgSQL ambiguity", async () => {
    const sql = await readFile(join(migrationsFolder, "0011_learning.sql"), "utf8");

    expect(sql.match(/UPDATE public\.api_command_receipts AS command_receipt SET/g)).toHaveLength(4);
    expect(sql).not.toContain("response=response,");
  });

  it("does not widen migrator grants on pre-0009 protected tables", async () => {
    const sql = await readFile(join(migrationsFolder, "0009_content.sql"), "utf8");

    expect(sql).not.toContain("GRANT ALL ON ALL TABLES IN SCHEMA public TO syntholo_migrator");
    expect(sql).toContain(
      "GRANT ALL ON public.courses,public.course_drafts,public.stages,public.stage_drafts,public.lessons,public.lesson_drafts",
    );
    expect(sql).not.toMatch(/GRANT ALL ON [^;]*public\.audit_events/u);
  });

  it("attests exact content object, immutability, table, and function authority", async () => {
    const sql = await readFile(join(migrationsFolder, "0009_content.sql"), "utf8");

    expect(sql).toContain(
      "GRANT SELECT,INSERT ON public.courses,public.stages,public.lessons TO syntholo_staff_api",
    );
    expect(sql).not.toMatch(/GRANT SELECT,INSERT,UPDATE ON [^;]*public\.courses/u);
    expect(sql).toContain("object_owner_ready boolean");
    expect(sql).toContain("object_type_ready boolean");
    expect(sql).toContain("immutable_triggers_ready boolean");
    expect(sql).toContain("table_acl_ready boolean");
    expect(sql).toContain("function_acl_ready boolean");
    expect(sql).toContain("public_execute_denied boolean");
    expect(sql).toContain("aclexplode(coalesce(c.relacl,'{}'::aclitem[]))");
    expect(sql).toContain("'TRIGGER','MAINTAIN']::text[]");
    expect(sql).toContain("aclexplode(coalesce(p.proacl,'{}'::aclitem[]))");
    expect(sql).toContain("t.tgtype<>27");
    expect(sql).toContain("p.proconfig<>ARRAY['search_path=pg_catalog, pg_temp']::text[]");
    expect(sql).toContain("a.grantee=0");
  });

  it("enforces one exact closed release-rule union on every persisted authority", async () => {
    const sql = await readFile(join(migrationsFolder, "0009_content.sql"), "utf8");

    for (const constraint of [
      "lesson_drafts_release_rule_check",
      "lesson_versions_release_rule_check",
      "course_draft_manifest_release_rule_check",
      "course_version_lessons_release_rule_check",
    ]) expect(sql).toContain(`CONSTRAINT ${constraint}`);
    expect(sql).not.toContain("jsonb_object_length");
    expect(sql.match(/release_rule - ARRAY\['kind','days'\]::text\[\] = '\{\}'::jsonb/g)).toHaveLength(4);
    expect(sql.match(/release_rule - ARRAY\['kind','at'\]::text\[\] = '\{\}'::jsonb/g)).toHaveLength(4);
    expect(sql.match(/isfinite\(\(release_rule->>'at'\)::timestamptz\)/g)).toHaveLength(4);
    expect(sql.match(/release_rule = '\{"kind":"immediate"\}'::jsonb/g)).toHaveLength(4);
  });

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
      { idx: 7, when: 1786669200000, tag: "0008_account_name", hash: "505693d0977b3cf51b156ac792605be7bf6e4a5c89c5ead8d4c728d1c298f513" },
      { idx: 8, when: 1786676400000, tag: "0009_content", hash: "2cf79d036accf426172ab2249e690e34c17a8f145c8e2afa72bb8e3994425922" },
      { idx: 9, when: 1786683600000, tag: "0010_content_assets", hash: "65e621c5754cb490c50dff009854433815dae8ee3fd3a6410de9dea6080fcb43" },
      { idx: 10, when: 1786770000000, tag: "0011_learning", hash: "2e37ec9d4bfeee1ad0319ae81172fac4107a87c798bd2f0eed79eb75ee0e2ccf" },
      { idx: 11, when: 1786856400000, tag: "0012_implementation", hash: "dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9" },
      { idx: 12, when: 1786942800000, tag: "0013_certificates", hash: "878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9" },
      { idx: 13, when: 1787029200000, tag: "0014_commerce_catalog", hash: "4bc124a641e6912d84fc6675133476f92e52e8fa89151079d05433d31deba8d4" },
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
