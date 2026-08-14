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
  query(input: Readonly<{
    query_timeout: number;
    text: string;
    values?: unknown[];
  }>): Promise<Readonly<{ rows: Array<Record<string, unknown>> }>>;
  release(destroy?: boolean): void;
}>;

type CronDatabase = Readonly<{
  pool: Readonly<{ connect(): Promise<CronClient> }>;
}>;

export type CronTimeouts = Readonly<{
  closeMs: number;
  connectMs: number;
  queryMs: number;
  unlockMs: number;
  workMs: number;
}>;

const CRON_TIMEOUTS: CronTimeouts = Object.freeze({
  closeMs: 5_000,
  connectMs: 5_000,
  queryMs: 5_000,
  unlockMs: 2_000,
  workMs: 10_000,
});
const STAFF_AUTH_CLEANUP_LIMIT = 500;

type FoundationCronResult = Readonly<
  | { status: "already-running" }
  | {
      loginAttemptsDeleted: number;
      sessionsDeleted: number;
      status: "completed";
    }
>;

function deadline<T>(
  run: () => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutCode: string,
  cancel: () => void = () => undefined,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("CRON_ABORTED"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => {
      cancel();
      reject(new Error("CRON_ABORTED"));
    });
    const timer = setTimeout(() => finish(() => {
      cancel();
      reject(new Error(timeoutCode));
    }), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(run)
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

function validCleanupCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function destroysConnection(error: unknown): boolean {
  return error instanceof Error
    && ["CRON_ABORTED", "CRON_DATABASE_TIMEOUT", "CRON_WORK_TIMEOUT"]
      .includes(error.message);
}

export async function closeCronDatabase(
  close: () => Promise<void>,
  timeoutMs = CRON_TIMEOUTS.closeMs,
): Promise<void> {
  await deadline(
    close,
    new AbortController().signal,
    timeoutMs,
    "CRON_CLOSE_TIMEOUT",
  );
}

export async function runFoundationCron(
  database: CronDatabase,
  checkReadiness: (signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
  timeouts: CronTimeouts = CRON_TIMEOUTS,
): Promise<FoundationCronResult> {
  if (signal.aborted) throw new Error("CRON_ABORTED");
  let abandonedConnect = false;
  const client = await deadline(
    async () => {
      const connected = await database.pool.connect();
      if (abandonedConnect) {
        connected.release(true);
        throw new Error("CRON_DATABASE_TIMEOUT");
      }
      return connected;
    },
    signal,
    timeouts.connectMs,
    "CRON_DATABASE_TIMEOUT",
    () => { abandonedConnect = true; },
  );
  let acquired = false;
  let destroy = false;
  let result: FoundationCronResult | undefined;
  let operationError: unknown;
  try {
    const lock = await deadline(
      () => client.query({
        query_timeout: timeouts.queryMs,
        text: "select pg_try_advisory_lock(7607539264896502273) as acquired",
      }),
      signal,
      timeouts.queryMs,
      "CRON_DATABASE_TIMEOUT",
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) {
      result = { status: "already-running" };
    } else {
      if (signal.aborted) throw new Error("CRON_ABORTED");
      const workController = new AbortController();
      await deadline(
        () => checkReadiness(workController.signal),
        signal,
        timeouts.workMs,
        "CRON_WORK_TIMEOUT",
        () => workController.abort(),
      );
      const cleanup = await deadline(
        () => client.query({
          query_timeout: timeouts.queryMs,
          text: "select login_attempts_deleted, sessions_deleted from public.cleanup_staff_auth(statement_timestamp(), $1)",
          values: [STAFF_AUTH_CLEANUP_LIMIT],
        }),
        signal,
        timeouts.queryMs,
        "CRON_DATABASE_TIMEOUT",
      );
      const row = cleanup.rows[0];
      if (
        cleanup.rows.length !== 1
        || !validCleanupCount(row?.login_attempts_deleted)
        || !validCleanupCount(row?.sessions_deleted)
      ) throw new Error("CRON_CLEANUP_INVALID");
      result = {
        loginAttemptsDeleted: row.login_attempts_deleted,
        sessionsDeleted: row.sessions_deleted,
        status: "completed",
      };
    }
  } catch (error) {
    destroy = destroysConnection(error);
    operationError = error;
  }
  let unlockError: Error | undefined;
  if (acquired && !destroy) {
    try {
      await deadline(
        () => client.query({
          query_timeout: timeouts.unlockMs,
          text: "select pg_advisory_unlock(7607539264896502273) as released",
        }),
        new AbortController().signal,
        timeouts.unlockMs,
        "CRON_UNLOCK_TIMEOUT",
      );
    } catch {
      destroy = true;
      unlockError = new Error("CRON_UNLOCK_TIMEOUT");
    }
  }
  client.release(destroy);
  if (operationError !== undefined) throw operationError;
  if (unlockError !== undefined) throw unlockError;
  if (result === undefined) throw new Error("CRON_RESULT_INVALID");
  return result;
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
            connectionTimeoutMs: CRON_TIMEOUTS.connectMs,
            queryTimeoutMs: CRON_TIMEOUTS.queryMs,
            url: config.databaseUrl,
          });
          await assertDatabaseCapability(database, "syntholo_worker");
          await runFoundationCron(
            database,
            async (workSignal) => {
              if (workSignal.aborted) throw new Error("CRON_ABORTED");
              const result = await checkDatabaseReadiness(
                database as Database,
                "syntholo_worker",
              );
              if (workSignal.aborted) throw new Error("CRON_ABORTED");
              return result;
            },
            signal,
          );
        },
      },
    });
  } finally {
    if (database !== undefined) {
      await closeCronDatabase(() => (database as Database).close());
    }
  }
}

if (isMainModule()) {
  void main().catch(() => {
    process.stderr.write("WORKER_STARTUP_FAILED\n");
    process.exitCode = 1;
  });
}
