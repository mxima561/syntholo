import { pathToFileURL } from "node:url";
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
  if (options.signal.aborted) return;
  await options.lifecycle.run(config, options.signal);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
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

  await startCron({
    signal: controller.signal,
    lifecycle: { run: async (_config, signal) => waitForAbort(signal) },
  });
}

if (isMainModule()) {
  void main().catch(() => {
    process.stderr.write("WORKER_STARTUP_FAILED\n");
    process.exitCode = 1;
  });
}
