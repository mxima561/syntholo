import Fastify from "fastify";
import { healthPayload } from "@syntholo/contracts";

export function buildWorker() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => healthPayload("worker"));
  return app;
}
