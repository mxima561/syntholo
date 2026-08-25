export const SCHOOL_ROLES = ["owner", "school_admin", "teacher", "student"] as const;
export type SchoolRole = (typeof SCHOOL_ROLES)[number];

/** @deprecated Use `student`. Kept for reading legacy membership rows during migration. */
export type LegacyMembershipRole = "teammate";

export type MembershipRole = SchoolRole;

export const SCHOOL_PERMISSIONS = [
  "view",
  "write_learning",
  "manage_courses",
  "manage_members",
  "manage_roles",
  "manage_settings",
  "manage_integrations",
  "manage_billing",
  "view_analytics",
  "delete_school",
] as const;
export type SchoolPermission = (typeof SCHOOL_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<SchoolRole, readonly SchoolPermission[]> = {
  owner: SCHOOL_PERMISSIONS,
  school_admin: [
    "view",
    "write_learning",
    "manage_courses",
    "manage_members",
    "manage_settings",
    "manage_integrations",
    "view_analytics",
  ],
  teacher: ["view", "write_learning", "manage_courses", "view_analytics"],
  student: ["view", "write_learning"],
};

export function isSchoolRole(value: unknown): value is SchoolRole {
  return value === "owner" || value === "school_admin" || value === "teacher" || value === "student";
}

export function normalizeSchoolRole(value: unknown): SchoolRole {
  if (isSchoolRole(value)) return value;
  if (value === "admin") return "school_admin";
  if (value === "member" || value === "teammate" || value === "viewer") return "student";
  return "student";
}

export function schoolRolePermissions(role: SchoolRole): readonly SchoolPermission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasSchoolPermission(role: SchoolRole, permission: SchoolPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function assertSchoolPermission(role: SchoolRole, permission: SchoolPermission): void {
  if (!hasSchoolPermission(role, permission)) {
    throw new Error("You do not have permission to do that in this academy account.");
  }
}

export const PLATFORM_ADMIN_ROLES = ["super_admin", "admin", "support", "finance"] as const;
export type PlatformAdminRole = (typeof PLATFORM_ADMIN_ROLES)[number];

export function isPlatformAdminRole(value: unknown): value is PlatformAdminRole {
  return (
    value === "super_admin" || value === "admin" || value === "support" || value === "finance"
  );
}

/**
 * Platform staff (`staff` / `platform_admins`) is independent of school membership.
 * An academy owner or school_admin is never a Syntholo operator by that membership alone.
 */
export function schoolRoleGrantsPlatformAccess(_role: SchoolRole): false {
  return false;
}

export const PLATFORM_CAPABILITIES = ["content", "support", "billing", "staff"] as const;
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

const PLATFORM_ROLE_CAPABILITIES: Record<PlatformAdminRole, readonly PlatformCapability[]> = {
  super_admin: PLATFORM_CAPABILITIES,
  admin: ["content", "support"],
  support: ["support"],
  finance: ["billing"],
};

export function normalizePlatformAdminRole(value: unknown): PlatformAdminRole {
  if (isPlatformAdminRole(value)) return value;
  if (value === "instructor") return "admin";
  return "support";
}

export function hasPlatformCapability(role: PlatformAdminRole, capability: PlatformCapability): boolean {
  return PLATFORM_ROLE_CAPABILITIES[role].includes(capability);
}

export function assertPlatformCapability(role: PlatformAdminRole, capability: PlatformCapability): void {
  if (!hasPlatformCapability(role, capability)) {
    throw new Error("This platform role cannot perform that operation.");
  }
}
