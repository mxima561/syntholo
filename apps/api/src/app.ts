import Fastify from "fastify";
import { healthPayload } from "@syntholo/contracts";

export function buildApi() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => healthPayload("api"));
  return app;
}
