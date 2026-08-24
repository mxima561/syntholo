export { getDb, getReadyDb } from "./client";
export type { DatabaseClient } from "./client";
export type { AdminAuditLog, Staff, StaffRole, StaffStatus } from "./types";
export { publicIdFromUuid } from "./ids";
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
export { writeActivityEvent, listActivityEvents, listDistinctActivityActions } from "./activity";
export type { ActivityEvent, ActivityEventInput, ActivityActorKind } from "./activity";
export {
  addCommunityComment,
  createLiveSession,
  createWorkflow,
  ensureStudentWorkspace,
  getCertificate,
  getCourseTemplate,
  getSoftwareAccount,
  issueCertificateIfEligible,
  listAllCommunityPosts,
  listArtifacts,
  listCommentsForPosts,
  listCommunityReports,
  listCourseTemplates,
  listLiveSessions,
  listScorecards,
  listSoftwareAccounts,
  listWorkflows,
  reportCommunityPost,
  resolveCommunityReport,
  rsvpLiveSession,
  saveArtifact,
  saveScorecard,
  saveSoftwareNote,
  setCommunityPostStatus,
  setWorkflowStatus,
  submitSoftwareProvisioning,
  toggleSoftwareChecklist,
  toggleSoftwareLaunchCheck,
  updateStudentProfile,
  updateWorkflow,
  DEFAULT_SOFTWARE_CHECKS,
  COURSE_TEMPLATES,
} from "./school";
export type {
  ArtifactKind,
  ArtifactRecord,
  CertificateRecord,
  CommunityComment,
  CommunityReport,
  CourseTemplate,
  LiveSessionRecord,
  ScorecardSubmission,
  SoftwareAccountRecord,
  SoftwareChecklistItem,
  WorkflowEngine,
  WorkflowRecord,
  WorkflowStatus,
} from "./school";
export { DEFAULT_SOFTWARE_CHECKLIST, ARTIFACT_STARTERS, upcomingOfficeHours } from "./catalog";
