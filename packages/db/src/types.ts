export type StaffRole = "admin" | "instructor" | "support";
export type StaffStatus = "active" | "suspended";

export type Staff = {
  id: string;
  email: string;
  role: StaffRole;
  status: StaffStatus;
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
