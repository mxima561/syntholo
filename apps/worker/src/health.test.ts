import { describe, expect, it } from "vitest";
import { createWorkerHealth } from "./health";

const releaseSha = "0123456789abcdef0123456789abcdef01234567";

describe("worker health evidence", () => {
  it.each(["starting", "ready", "draining", "stopped"] as const)(
    "reports %s with only immutable public process metadata",
    (status) => {
      expect(createWorkerHealth(releaseSha, status)).toEqual({
        releaseSha,
        service: "worker",
        status,
      });
    },
  );

  it("rejects a malformed release", () => {
    expect(() => createWorkerHealth("test", "ready"))
      .toThrow("WORKER_HEALTH_INVALID");
  });
});
