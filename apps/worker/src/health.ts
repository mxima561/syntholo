export type WorkerHealthStatus = "starting" | "ready" | "draining" | "stopped";

export function createWorkerHealth(
  releaseSha: string,
  status: WorkerHealthStatus,
) {
  if (!/^[0-9a-f]{40}$/u.test(releaseSha)) {
    throw new Error("WORKER_HEALTH_INVALID");
  }
  return Object.freeze({
    releaseSha,
    service: "worker" as const,
    status,
  });
}
