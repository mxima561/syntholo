import { describe, expect, it, vi } from "vitest";
import type { StaffRole } from "@syntholo/db";
import { staffHasCapability } from "./staff";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@syntholo/auth/server", () => ({
  getNeonAuthUser: vi.fn(),
  getNeonAuth: vi.fn(() => null),
}));

describe("staffHasCapability", () => {
  it("super_admin has billing/content/support/staff", () => {
    const role: StaffRole = "super_admin";
    expect(staffHasCapability(role, "billing")).toBe(true);
    expect(staffHasCapability(role, "content")).toBe(true);
    expect(staffHasCapability(role, "support")).toBe(true);
    expect(staffHasCapability(role, "staff")).toBe(true);
  });

  it("operational admin has content and support, not billing or staff", () => {
    const role: StaffRole = "admin";
    expect(staffHasCapability(role, "content")).toBe(true);
    expect(staffHasCapability(role, "support")).toBe(true);
    expect(staffHasCapability(role, "billing")).toBe(false);
    expect(staffHasCapability(role, "staff")).toBe(false);
  });

  it("support has support only (not billing, content, staff)", () => {
    const role: StaffRole = "support";
    expect(staffHasCapability(role, "support")).toBe(true);
    expect(staffHasCapability(role, "billing")).toBe(false);
    expect(staffHasCapability(role, "content")).toBe(false);
    expect(staffHasCapability(role, "staff")).toBe(false);
  });

  it("finance has billing only", () => {
    const role: StaffRole = "finance";
    expect(staffHasCapability(role, "billing")).toBe(true);
    expect(staffHasCapability(role, "staff")).toBe(false);
    expect(staffHasCapability(role, "content")).toBe(false);
  });
});
