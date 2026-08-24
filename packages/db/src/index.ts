export { getDb, getReadyDb } from "./client";
export type { DatabaseClient } from "./client";
export { withAccountScope, withStaffScope, withSystemScope, withUserAccountScope } from "./scope";
export {
  acceptInvitation,
  ensureAccountForUser,
  findMembershipByUserId,
  getInvitationPreview,
  inviteTeammate,
  listMemberships,
  listPendingInvitations,
  listSeatMembers,
  revokeInvitation,
  revokeMembership,
} from "./accounts";
export type { InvitationPreview, InvitationRecord, MembershipRecord, MembershipRole, SeatMember } from "./accounts";
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
export {
  ensureDemoAcademyGrants,
  hasActiveCapability,
  listGrantsForAccount,
  listGrantsForUser,
  refundGrantsForPurchase,
  revokeEntitlementGrants,
  supportWindowEnd,
  upsertEntitlementGrant,
} from "./entitlements";
export type { EntitlementGrantRecord } from "./entitlements";
export type { EnrollmentSnapshot, PurchaseSnapshot, RefundResult } from "./refunds";
export { fulfillCheckout, getPurchasesForUser, revokeSubscription } from "./purchases";
export type { PurchaseRecord } from "./purchases";
export { dispatchStripeEvent, handleCheckoutCompleted, handleSubscriptionCanceled } from "./stripe-events";
export { PgWebhookReceiptStore } from "./webhook-receipts";
export {
  addCoachReply,
  addCustomerReply,
  assertOwnedThread,
  createSupportThread,
  ensureWelcomeThread,
  getThreadMessages,
  listAllThreads,
  listThreadsForUser,
  updateThreadStatus,
} from "./support";
export type { SupportMessageRecord, SupportThreadSummary } from "./support";
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
