import { pathToFileURL } from "node:url";
import {
  assertDatabaseCapability,
  checkDatabaseReadiness,
  createDatabase,
  type Database,
} from "@syntholo/database";
import {
  parseWorkerConfig,
  type RuntimeEnvironment,
  type WorkerConfig,
} from "./config.js";

export type CronLifecycle = Readonly<{
  run(config: WorkerConfig, signal: AbortSignal): Promise<void>;
}>;

export type StartCronOptions = Readonly<{
  env?: RuntimeEnvironment;
  signal: AbortSignal;
  lifecycle: CronLifecycle;
}>;

export async function startCron(options: StartCronOptions): Promise<void> {
  const config = parseWorkerConfig(options.env ?? process.env);
  if (options.signal.aborted) throw new Error("CRON_ABORTED");
  await options.lifecycle.run(config, options.signal);
}

type CronClient = Readonly<{
  query(sql: string): Promise<Readonly<{ rows: Array<Record<string, unknown>> }>>;
  release(): void;
}>;

type CronDatabase = Readonly<{
  pool: Readonly<{ connect(): Promise<CronClient> }>;
}>;

export async function runFoundationCron(
  database: CronDatabase,
  checkReadiness: () => Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new Error("CRON_ABORTED");
  const client = await database.pool.connect();
  let acquired = false;
  try {
    const lock = await client.query(
      "select pg_try_advisory_lock(7607539264896502273) as acquired",
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) throw new Error("CRON_ALREADY_RUNNING");
    if (signal.aborted) throw new Error("CRON_ABORTED");
    await checkReadiness();
  } finally {
    if (acquired) {
      await client.query(
        "select pg_advisory_unlock(7607539264896502273) as released",
      ).catch(() => undefined);
    }
    client.release();
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let database: Database | undefined;
  try {
    await startCron({
      signal: controller.signal,
      lifecycle: {
        run: async (config, signal) => {
          database = createDatabase({
            applicationName: `syntholo-cron-${config.releaseSha}`,
            url: config.databaseUrl,
          });
          await assertDatabaseCapability(database, "syntholo_worker");
          await runFoundationCron(
            database,
            () => checkDatabaseReadiness(database as Database, "syntholo_worker"),
            signal,
          );
        },
      },
    });
  } finally {
    await database?.close();
  }
}

if (isMainModule()) {
  void main().catch(() => {
    process.stderr.write("WORKER_STARTUP_FAILED\n");
    process.exitCode = 1;
  });
}
