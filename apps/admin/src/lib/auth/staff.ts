import { headers, cookies } from "next/headers";
import {
  bindStaffNeonUserId,
  findStaffByEmail,
  findStaffByNeonUserId,
  hasPlatformCapability,
  touchStaffLastSeen,
  type PlatformCapability,
  type Staff,
  type StaffRole,
} from "@syntholo/db";
import { isNeonAuthConfigured } from "@syntholo/auth/config";
import { getNeonAuthUser } from "@syntholo/auth/server";
import { authorizeStaffRow } from "./authorize-staff";
import { cloudflareAccessAllows } from "./access-gate";
import { adminRuntime } from "./access-runtime";
import { resolveDevBypassEmail } from "./bypass";

export class AdminForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "AdminForbiddenError";
  }
}

export class AdminUnauthenticatedError extends Error {
  constructor() {
    super("Unauthenticated");
    this.name = "AdminUnauthenticatedError";
  }
}

export type StaffCapability = PlatformCapability;

/**
 * Cloudflare Access is reachability only. A valid Access JWT does not identify
 * the Syntholo actor and does not grant platform_admins permissions.
 */
export async function assertCloudflareAccess(): Promise<void> {
  const headerStore = await headers();
  const cookieStore = await cookies();
  const allowed = await cloudflareAccessAllows({
    header: headerStore.get("cf-access-jwt-assertion"),
    cookie: cookieStore.get("CF_Authorization")?.value ?? null,
  });
  if (!allowed) throw new AdminForbiddenError();
}

async function resolvePlatformStaff(): Promise<Staff> {
  if (isNeonAuthConfigured()) {
    const user = await getNeonAuthUser();
    if (!user) throw new AdminUnauthenticatedError();
    const byNeon = await findStaffByNeonUserId(user.id);
    if (byNeon) return byNeon;
    const byEmail = await findStaffByEmail(user.email);
    if (byEmail) {
      return (await bindStaffNeonUserId(byEmail.id, user.id)) ?? byEmail;
    }
    throw new AdminForbiddenError();
  }

  if (adminRuntime() === "development") {
    const bypass = resolveDevBypassEmail();
    if (bypass) {
      const staff = await findStaffByEmail(bypass.toLowerCase());
      if (staff) return staff;
    }
  }
  throw new AdminUnauthenticatedError();
}

export function staffHasCapability(role: StaffRole, capability: StaffCapability): boolean {
  return hasPlatformCapability(role, capability);
}

export async function requireStaff(capability?: StaffCapability): Promise<Staff> {
  await assertCloudflareAccess();
  const staff = await resolvePlatformStaff();
  if (!authorizeStaffRow(staff)) throw new AdminForbiddenError();
  if (capability && !staffHasCapability(staff.role, capability)) throw new AdminForbiddenError();
  await touchStaffLastSeen(staff.id);
  return staff;
}

export async function requestAuditContext() {
  const headerStore = await headers();
  return {
    ip: headerStore.get("cf-connecting-ip") ?? headerStore.get("x-forwarded-for"),
    userAgent: headerStore.get("user-agent"),
  };
}

export function staffDisplayName(staff: Staff): string {
  return staff.email.split("@")[0] ?? staff.email;
}

export function staffInitials(staff: Staff): string {
  return staff.email.slice(0, 2).toUpperCase();
}
