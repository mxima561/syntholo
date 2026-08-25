export { getDb, getReadyDb, closeDb } from "./client";
export type { DatabaseClient } from "./client";
export { withAccountScope, withStaffScope, withSystemScope, withUserAccountScope } from "./scope";
export {
  acceptInvitation,
  ensureAccountForUser,
  findMembershipByUserId,
  getInvitationPreview,
  inviteTeammate,
  listMemberships,
  listMembershipsForUser,
  listPendingInvitations,
  listSeatMembers,
  revokeInvitation,
  revokeMembership,
  setActiveAccount,
} from "./accounts";
export type { InvitationPreview, InvitationRecord, MembershipRecord, MembershipRole, SeatMember } from "./accounts";
export type { AdminAuditLog, Staff, StaffRole, StaffStatus } from "./types";
export { publicIdFromUuid } from "./ids";
export {
  bindStaffNeonUserId,
  findStaffByEmail,
  findStaffByNeonUserId,
  insertStaff,
  listStaff,
  touchStaffLastSeen,
  updateStaffRole,
  updateStaffStatus,
} from "./staff";
export {
  assertPlatformCapability,
  assertSchoolPermission,
  hasPlatformCapability,
  hasSchoolPermission,
  normalizePlatformAdminRole,
  normalizeSchoolRole,
  schoolRoleGrantsPlatformAccess,
} from "./permissions";
export type { PlatformAdminRole, PlatformCapability, SchoolPermission, SchoolRole } from "./permissions";
export { recordIdentityMigration } from "./identity";
export { listAuditForTarget, writeAdminAudit } from "./audit";
export type { AdminAuditInput } from "./audit";
export {
  appendAudit,
  bootstrapOutboxModel,
  claimJobs,
  completeJob,
  enqueueJob,
  enqueueOutbox,
  failJob,
  markOutboxPublished,
  mutateWithEvent,
  recordHandlerReceipt,
  safeJobErrorCode,
  safeJobErrorMessage,
} from "./outbox";
export type { AuditActorKind, JobRecord, JobStatus } from "./outbox";
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
  listGrantsForAccount,
  listGrantsForUser,
  refundGrantsForPurchase,
  revokeEntitlementGrants,
  supportWindowEnd,
  upsertEntitlementGrant,
} from "./entitlements";
export { hasActiveCapability, loadEffectiveAccess } from "./access";
export { clearAccountHold, listAccountHolds, setAccountHold } from "./holds";
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
export { persistScorecardLead, getPublicScorecardReport, attachScorecardsForVerifiedEmail } from "./scorecards";
export type { PersistedScorecard, PublicScorecardReport } from "./scorecards";
export { submitPilotApplication, reviewPilotApplication } from "./applications";
export type { PilotApplicationRecord } from "./applications";
export { DEFAULT_SOFTWARE_CHECKLIST, ARTIFACT_STARTERS, upcomingOfficeHours } from "./catalog";
