import { headers, cookies } from "next/headers";
import { findStaffByEmail, touchStaffLastSeen, type Staff, type StaffRole } from "@syntholo/db";
import { authorizeStaffRow } from "./authorize-staff";
import { accessCertsUrl, accessIssuer, getCachedRemoteJwks, readAccessToken, verifyAccessJwt } from "./access-jwt";
import { resolveDevBypassEmail } from "./bypass";

export class AdminForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "AdminForbiddenError";
  }
}

const CAPABILITIES = {
  content: ["admin", "instructor"],
  support: ["admin", "support"],
  billing: ["admin"],
  staff: ["admin"],
} as const;

export type StaffCapability = keyof typeof CAPABILITIES;

async function verifiedEmail(): Promise<string> {
  if (process.env.NODE_ENV !== "production") {
    const bypass = resolveDevBypassEmail();
    if (bypass) return bypass.toLowerCase();
  }

  const headerStore = await headers();
  const cookieStore = await cookies();
  const token = readAccessToken({
    header: headerStore.get("cf-access-jwt-assertion"),
    cookie: cookieStore.get("CF_Authorization")?.value ?? null,
  });
  const aud = process.env.CF_ACCESS_AUD?.trim();
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
  if (!token || !aud || !teamDomain) throw new AdminForbiddenError();

  const verified = await verifyAccessJwt(token, {
    aud,
    issuer: accessIssuer(teamDomain),
    jwks: getCachedRemoteJwks(accessCertsUrl(teamDomain)),
  });
  if (!verified.ok) throw new AdminForbiddenError();
  return verified.email;
}

export async function requireStaff(capability?: StaffCapability): Promise<Staff> {
  const email = await verifiedEmail();
  const staff = await findStaffByEmail(email);
  if (!authorizeStaffRow(staff)) throw new AdminForbiddenError();
  if (capability) {
    const allowed = CAPABILITIES[capability] as readonly StaffRole[];
    if (!allowed.includes(staff.role)) throw new AdminForbiddenError();
  }
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
