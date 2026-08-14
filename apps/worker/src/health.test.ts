import { describe, expect, it } from "vitest";
import { createWorkerHealth, emitWorkerHealth } from "./health";

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

  it("emits one newline-delimited SHA-bound ready record without runtime configuration", () => {
    const output: string[] = [];
    emitWorkerHealth(releaseSha, "ready", (value) => {
      output.push(value);
      return true;
    });
    expect(output).toEqual([
      `${JSON.stringify({ releaseSha, service: "worker", status: "ready" })}\n`,
    ]);
  });
});
