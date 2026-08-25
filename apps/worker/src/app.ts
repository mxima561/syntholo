import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { healthPayload } from "@syntholo/contracts";

async function tickJobs() {
  const { processJobBatch } = await import("./jobs");
  const result = await processJobBatch({
    workerId: "local-tick",
    limit: 25,
    now: new Date(),
  });
  return {
    ok: true as const,
    claimed: result.claimed,
    completed: result.completed,
    failed: result.failed,
  };
}

async function runTick(_request: FastifyRequest, reply: FastifyReply) {
  try {
    return await tickJobs();
  } catch {
    return reply.code(503).send({ ok: false, error: "Worker jobs are unavailable." });
  }
}

export function buildWorker() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => healthPayload("worker"));
  app.post("/jobs/tick", runTick);
  return app;
}
