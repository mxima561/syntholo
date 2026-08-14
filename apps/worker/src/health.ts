export type WorkerHealthStatus = "starting" | "ready" | "draining" | "stopped";

export function createWorkerHealth(
  releaseSha: string,
  status: WorkerHealthStatus,
  createdAt: Date = new Date(),
) {
  if (!/^[0-9a-f]{40}$/u.test(releaseSha) || !Number.isFinite(createdAt.getTime())) {
    throw new Error("WORKER_HEALTH_INVALID");
  }
  return Object.freeze({
    createdAt: createdAt.toISOString(),
    releaseSha,
    service: "worker" as const,
    status,
  });
}

export function emitWorkerHealth(
  releaseSha: string,
  status: WorkerHealthStatus,
  write: (value: string) => unknown = (value) => process.stdout.write(value),
  createdAt: Date = new Date(),
): void {
  write(`${JSON.stringify(createWorkerHealth(releaseSha, status, createdAt))}\n`);
}
