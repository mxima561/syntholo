import { describe, expect, it } from "vitest";
import { publicIdFromUuid } from "./ids";

describe("publicIdFromUuid", () => {
  it("builds a stable short student id from a UUID", () => {
    expect(publicIdFromUuid("a1b2c3d4-e5f6-7890-abcd-ef0123456789", "STU")).toBe("STU-A1B2C3D4");
  });

  it("uses STF for staff", () => {
    expect(publicIdFromUuid("11111111-2222-3333-4444-555555555555", "STF")).toBe("STF-11111111");
  });
});
