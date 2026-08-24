export { getDb, getReadyDb } from "./client";
export type { DatabaseClient } from "./client";
export type { AdminAuditLog, Staff, StaffRole, StaffStatus } from "./types";
export {
  findStaffByEmail,
  insertStaff,
  listStaff,
  touchStaffLastSeen,
  updateStaffRole,
  updateStaffStatus,
} from "./staff";
export { listAuditForTarget, writeAdminAudit } from "./audit";
export type { AdminAuditInput } from "./audit";
export {
  applyPurchaseRefund,
  grantCourseEntitlement,
  listEnrollmentsForUser,
  listPaidPurchases,
  loadPurchaseRefundSnapshot,
  refundStateTransition,
  revokeCourseEntitlement,
} from "./refunds";
export type { EnrollmentSnapshot, PurchaseSnapshot, RefundResult } from "./refunds";
