import { describe, expect, it } from "vitest";
import { assertOwnedThread } from "./support";

describe("assertOwnedThread", () => {
  it("allows the owner to continue", () => {
    expect(() => assertOwnedThread({ userId: "stu-1" }, "stu-1")).not.toThrow();
  });

  it("hides another student's thread", () => {
    expect(() => assertOwnedThread({ userId: "stu-1" }, "stu-2")).toThrow(/not found/i);
  });

  it("hides an unknown thread id", () => {
    expect(() => assertOwnedThread(null, "stu-1")).toThrow(/not found/i);
  });
});
