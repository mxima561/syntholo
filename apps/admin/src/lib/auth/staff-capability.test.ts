import { describe, expect, it } from "vitest";
import { staffHasCapability } from "./staff";
import type { StaffRole } from "@syntholo/db";

describe("staffHasCapability", () => {
  it("admin has billing/content/support/staff", () => {
    const role: StaffRole = "admin";
    expect(staffHasCapability(role, "billing")).toBe(true);
    expect(staffHasCapability(role, "content")).toBe(true);
    expect(staffHasCapability(role, "support")).toBe(true);
    expect(staffHasCapability(role, "staff")).toBe(true);
  });

  it("instructor has content only (not billing, support, staff)", () => {
    const role: StaffRole = "instructor";
    expect(staffHasCapability(role, "content")).toBe(true);
    expect(staffHasCapability(role, "billing")).toBe(false);
    expect(staffHasCapability(role, "support")).toBe(false);
    expect(staffHasCapability(role, "staff")).toBe(false);
  });

  it("support has support only (not billing, content, staff)", () => {
    const role: StaffRole = "support";
    expect(staffHasCapability(role, "support")).toBe(true);
    expect(staffHasCapability(role, "billing")).toBe(false);
    expect(staffHasCapability(role, "content")).toBe(false);
    expect(staffHasCapability(role, "staff")).toBe(false);
  });
});
