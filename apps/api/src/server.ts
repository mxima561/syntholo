import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp, type ApiDependencies } from "./app.js";
import {
  parseApiConfig,
  type ApiConfig,
  type RuntimeEnvironment,
} from "./config.js";

type BuildApp = (dependencies: ApiDependencies) => Promise<FastifyInstance>;
type Listen = (
  app: FastifyInstance,
  address: Readonly<{ host: string; port: number }>,
) => Promise<unknown>;

export type StartApiOptions = Readonly<{
  env?: RuntimeEnvironment;
  build?: BuildApp;
  listen?: Listen;
}>;

function apiDependencies(config: ApiConfig): ApiDependencies {
  return {
    releaseSha: config.releaseSha,
    logger: config.environment === "production",
    health: { dependencies: [] },
  };
}

export async function startApi(
  options: StartApiOptions = {},
): Promise<FastifyInstance> {
  const config = parseApiConfig(options.env ?? process.env);
  const app = await (options.build ?? buildApp)(apiDependencies(config));
  const listen =
    options.listen ??
    ((instance: FastifyInstance, address: { host: string; port: number }) =>
      instance.listen(address));

  try {
    await listen(app, { host: config.host, port: config.port });
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

async function main(): Promise<void> {
  const app = await startApi();
  const stop = () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (isMainModule()) {
  void main().catch(() => {
    process.stderr.write("API_STARTUP_FAILED\n");
    process.exitCode = 1;
  });
}
