import { describe, expect, it } from "vitest";
import { authorizeStaffRow } from "./authorize-staff";
import type { Staff } from "@syntholo/db";

function staff(overrides: Partial<Staff> = {}): Staff {
  return {
    id: "s1",
    email: "ops@syntholo.com",
    role: "admin",
    status: "active",
    createdAt: new Date(),
    lastSeenAt: null,
    ...overrides,
  };
}

describe("authorizeStaffRow", () => {
  it("rejects a valid Access identity with no staff row", () => {
    expect(authorizeStaffRow(null)).toBe(false);
  });

  it("rejects a suspended staff row", () => {
    expect(authorizeStaffRow(staff({ status: "suspended" }))).toBe(false);
  });

  it("allows an active staff row", () => {
    expect(authorizeStaffRow(staff())).toBe(true);
  });
});
