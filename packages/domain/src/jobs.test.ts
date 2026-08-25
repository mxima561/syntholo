import { describe, expect, it } from "vitest";
import { nextAttempt } from "./jobs";

const now = new Date("2026-08-24T12:00:00.000Z");

describe("nextAttempt", () => {
  it("delays about one second on attempt 0", () => {
    for (let index = 0; index < 20; index += 1) {
      const delay = nextAttempt(0, now).getTime() - now.getTime();
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(1_250);
    }
  });

  it("caps high attempts at one hour plus jitter", () => {
    for (const attempt of [12, 20, 40]) {
      const delay = nextAttempt(attempt, now).getTime() - now.getTime();
      expect(delay).toBeGreaterThanOrEqual(3_600_000);
      expect(delay).toBeLessThanOrEqual(3_600_250);
    }
  });
});
