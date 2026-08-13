import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import {
  parseWorkerConfig,
  type RuntimeEnvironment,
  type WorkerConfig,
} from "./config.js";

export type WorkerJob = Readonly<{
  id: string;
  type: string;
}>;

export type WorkerDependencies<TJob extends WorkerJob> = Readonly<{
  config: WorkerConfig;
  workerId: string;
  clock: Readonly<{ now(): Date }>;
  jobs: Readonly<{
    claim(
      concurrency: number,
      workerId: string,
      now: Date,
    ): Promise<readonly TJob[]>;
  }>;
  handlers: Readonly<{ handle(job: TJob): Promise<void> }>;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}>;

export function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function runWorker<TJob extends WorkerJob>(
  dependencies: WorkerDependencies<TJob>,
  signal: AbortSignal,
): Promise<void> {
  const config = parseWorkerConfig({
    DATABASE_URL: dependencies.config.databaseUrl,
    RELEASE_SHA: dependencies.config.releaseSha,
    WORKER_CONCURRENCY: String(dependencies.config.concurrency),
    WORKER_IDLE_DELAY_MS: String(dependencies.config.idleDelayMs),
  });
  const wait = dependencies.wait ?? abortableDelay;

  while (!signal.aborted) {
    const jobs = await dependencies.jobs.claim(
      config.concurrency,
      dependencies.workerId,
      dependencies.clock.now(),
    );
    await Promise.all(jobs.map((job) => dependencies.handlers.handle(job)));

    if (jobs.length === 0 && !signal.aborted) {
      await wait(config.idleDelayMs, signal);
    }
  }
}

type WorkerRuntimeDependencies<TJob extends WorkerJob> = Omit<
  WorkerDependencies<TJob>,
  "config"
>;

export type StartWorkerOptions<TJob extends WorkerJob> = Readonly<{
  env?: RuntimeEnvironment;
  signal: AbortSignal;
  createDependencies(
    config: WorkerConfig,
  ): WorkerRuntimeDependencies<TJob>;
}>;

export async function startWorker<TJob extends WorkerJob>(
  options: StartWorkerOptions<TJob>,
): Promise<void> {
  const config = parseWorkerConfig(options.env ?? process.env);
  const dependencies = options.createDependencies(config);
  await runWorker(
    {
      ...dependencies,
      config,
    },
    options.signal,
  );
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

  await startWorker({
    signal: controller.signal,
    createDependencies: () => ({
      workerId: `${hostname()}-${process.pid}`,
      clock: { now: () => new Date() },
      jobs: { claim: async () => [] },
      handlers: { handle: async () => undefined },
    }),
  });
}

if (isMainModule()) {
  void main().catch(() => {
    process.stderr.write("WORKER_STARTUP_FAILED\n");
    process.exitCode = 1;
  });
}
