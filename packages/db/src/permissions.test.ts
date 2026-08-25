import { describe, expect, it } from "vitest";
import {
  assertSchoolPermission,
  hasPlatformCapability,
  hasSchoolPermission,
  normalizePlatformAdminRole,
  normalizeSchoolRole,
  schoolRoleGrantsPlatformAccess,
  schoolRolePermissions,
} from "./permissions";

describe("school permissions", () => {
  it("maps legacy teammate memberships to student", () => {
    expect(normalizeSchoolRole("teammate")).toBe("student");
    expect(normalizeSchoolRole("admin")).toBe("school_admin");
    expect(normalizeSchoolRole("owner")).toBe("owner");
  });

  it("gives owners billing and member management", () => {
    expect(hasSchoolPermission("owner", "manage_billing")).toBe(true);
    expect(hasSchoolPermission("owner", "manage_members")).toBe(true);
    expect(hasSchoolPermission("school_admin", "manage_billing")).toBe(false);
    expect(hasSchoolPermission("school_admin", "manage_members")).toBe(true);
    expect(hasSchoolPermission("teacher", "manage_courses")).toBe(true);
    expect(hasSchoolPermission("teacher", "manage_members")).toBe(false);
    expect(hasSchoolPermission("student", "write_learning")).toBe(true);
    expect(hasSchoolPermission("student", "manage_courses")).toBe(false);
  });

  it("never treats a school role as Syntholo platform access", () => {
    for (const role of ["owner", "school_admin", "teacher", "student"] as const) {
      expect(schoolRoleGrantsPlatformAccess(role)).toBe(false);
      expect(schoolRolePermissions(role).length).toBeGreaterThan(0);
    }
  });

  it("throws a shared permission error", () => {
    expect(() => assertSchoolPermission("student", "manage_billing")).toThrow(/permission/i);
  });
});

describe("platform admin capabilities", () => {
  it("maps legacy instructor to operational admin", () => {
    expect(normalizePlatformAdminRole("instructor")).toBe("admin");
    expect(normalizePlatformAdminRole("admin")).toBe("admin");
    expect(normalizePlatformAdminRole("super_admin")).toBe("super_admin");
  });

  it("keeps support off billing and staff management", () => {
    expect(hasPlatformCapability("support", "support")).toBe(true);
    expect(hasPlatformCapability("support", "billing")).toBe(false);
    expect(hasPlatformCapability("support", "staff")).toBe(false);
    expect(hasPlatformCapability("support", "content")).toBe(false);
  });

  it("reserves staff administration for super_admin", () => {
    expect(hasPlatformCapability("super_admin", "staff")).toBe(true);
    expect(hasPlatformCapability("admin", "staff")).toBe(false);
    expect(hasPlatformCapability("finance", "billing")).toBe(true);
    expect(hasPlatformCapability("finance", "content")).toBe(false);
  });
});
