import { describe, expect, it } from "vitest";
import { assertOwnedThread } from "./support";

describe("assertOwnedThread", () => {
  it("allows the owner to continue", () => {
    expect(() => assertOwnedThread({ accountId: "acc-1" }, "acc-1")).not.toThrow();
  });

  it("hides another account's thread", () => {
    expect(() => assertOwnedThread({ accountId: "acc-1" }, "acc-2")).toThrow(/not found/i);
  });

  it("hides an unknown thread id", () => {
    expect(() => assertOwnedThread(null, "acc-1")).toThrow(/not found/i);
  });
});
