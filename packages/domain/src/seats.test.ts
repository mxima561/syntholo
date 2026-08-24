import { describe, expect, it } from "vitest";
import { ACADEMY_SEAT_LIMIT, assertCanInviteAcademySeat, canInviteAcademySeat, remainingAcademySeats } from "./seats";

describe("academy seats", () => {
  it("reserves three seats", () => {
    expect(ACADEMY_SEAT_LIMIT).toBe(3);
    expect(remainingAcademySeats(1)).toBe(2);
    expect(canInviteAcademySeat(3)).toBe(false);
  });

  it("rejects a fourth invite", () => {
    expect(() => assertCanInviteAcademySeat(3)).toThrow(/three seats/i);
  });
});
