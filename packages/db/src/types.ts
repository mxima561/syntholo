import type { PlatformAdminRole } from "./permissions";

export type StaffRole = PlatformAdminRole;
export type StaffStatus = "active" | "suspended";

export type Staff = {
  id: string;
  publicId: string;
  email: string;
  role: StaffRole;
  status: StaffStatus;
  neonUserId: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
};

export type AdminAuditLog = {
  id: string;
  actorStaffId: string;
  action: string;
  targetType: string;
  targetId: string;
  beforeJson: unknown;
  afterJson: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
};
