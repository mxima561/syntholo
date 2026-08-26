"use server";

import { forbidden, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  grantCourseEntitlement,
  insertStaff,
  listEnrollmentsForUser,
  revokeCourseEntitlement,
  updateStaffRole,
  updateStaffStatus,
  writeAdminAudit,
  type StaffRole,
  type StaffStatus,
} from "@syntholo/db";
import { performAuditedRefund } from "@/lib/auth/refund-mutation";
import { AdminForbiddenError, requestAuditContext, requireStaff, staffDisplayName } from "@/lib/auth/staff";
import {
  createLesson,
  deleteLesson,
  getLessonById,
  setCourseStatus,
  updateLesson,
  updateStage,
} from "@/lib/server/courses";
import { addCoachReply, updateThreadStatus } from "@/lib/server/support";

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function number(formData: FormData, key: string, fallback: number): number {
  const parsed = Number.parseInt(text(formData, key), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function staffOrForbidden<T extends "content" | "support" | "billing" | "staff">(capability: T) {
  try {
    return await requireStaff(capability);
  } catch (error) {
    if (error instanceof AdminForbiddenError) forbidden();
    throw error;
  }
}

async function audit(action: string, targetType: string, targetId: string, before: unknown, after: unknown, actorStaffId: string) {
  const { ip, userAgent } = await requestAuditContext();
  await writeAdminAudit({ actorStaffId, action, targetType, targetId, before, after, ip, userAgent });
}

export async function createLessonAction(formData: FormData) {
  const staff = await staffOrForbidden("content");
  const courseId = text(formData, "courseId");
  const stageId = text(formData, "stageId");
  const title = text(formData, "title");
  if (!courseId || !stageId || !title) return;
  const lessonId = await createLesson({ courseId, stageId, title });
  await audit("create_lesson", "lesson", lessonId, null, { courseId, stageId, title }, staff.id);
  revalidatePath("/", "layout");
  redirect(`/content/${lessonId}`);
}

export async function updateLessonAction(formData: FormData) {
  const staff = await staffOrForbidden("content");
  const lessonId = text(formData, "lessonId");
  if (!lessonId) return;
  const before = await getLessonById(lessonId, true);
  const after = {
    title: text(formData, "title"),
    summary: text(formData, "summary"),
    actionLabel: text(formData, "actionLabel"),
    durationMinutes: number(formData, "durationMinutes", 10),
    resourceCount: number(formData, "resourceCount", 1),
    videoUrl: text(formData, "videoUrl") || null,
    transcript: text(formData, "transcript").split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean),
    isPublished: formData.get("isPublished") === "on",
    stageId: text(formData, "stageId") || undefined,
  };
  await updateLesson(lessonId, after);
  await audit("update_lesson", "lesson", lessonId, before, after, staff.id);
  revalidatePath("/", "layout");
}

export async function toggleLessonPublishAction(formData: FormData) {
  const staff = await staffOrForbidden("content");
  const lessonId = text(formData, "lessonId");
  const isPublished = text(formData, "isPublished") === "true";
  if (!lessonId) return;
  const before = await getLessonById(lessonId, true);
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  await db`UPDATE lessons SET is_published = ${isPublished}, updated_at = now() WHERE id = ${lessonId}`;
  await audit("toggle_lesson_publish", "lesson", lessonId, { isPublished: before?.isPublished }, { isPublished }, staff.id);
  revalidatePath("/", "layout");
}

export async function deleteLessonAction(formData: FormData) {
  const staff = await staffOrForbidden("content");
  const lessonId = text(formData, "lessonId");
  if (!lessonId) return;
  const before = await getLessonById(lessonId, true);
  await deleteLesson(lessonId);
  await audit("delete_lesson", "lesson", lessonId, before, null, staff.id);
  revalidatePath("/", "layout");
  redirect("/content");
}

export async function setCourseStatusAction(formData: FormData) {
  const staff = await staffOrForbidden("content");
  const courseId = text(formData, "courseId");
  const status = text(formData, "status") === "published" ? "published" : "draft";
  if (!courseId) return;
  await setCourseStatus(courseId, status);
  await audit("set_course_status", "course", courseId, null, { status }, staff.id);
  revalidatePath("/", "layout");
}

export async function updateStageAction(formData: FormData) {
  const staff = await staffOrForbidden("content");
  const stageId = text(formData, "stageId");
  if (!stageId) return;
  const after = {
    title: text(formData, "title"),
    shortTitle: text(formData, "shortTitle"),
    description: text(formData, "description"),
  };
  await updateStage(stageId, after);
  await audit("update_stage", "stage", stageId, null, after, staff.id);
  revalidatePath("/", "layout");
}

export async function coachReplyAction(formData: FormData) {
  const staff = await staffOrForbidden("support");
  const threadId = text(formData, "threadId");
  const body = text(formData, "body");
  if (!threadId || !body) return;
  await addCoachReply({
    threadId,
    coachName: staffDisplayName(staff),
    body,
  });
  await audit("support_reply", "support_thread", threadId, null, { body }, staff.id);
  revalidatePath("/support");
}

export async function setThreadStatusAction(formData: FormData) {
  const staff = await staffOrForbidden("support");
  const threadId = text(formData, "threadId");
  const status = text(formData, "status") as "resolved" | "closed" | "waiting_on_coach";
  if (!threadId || !["resolved", "closed", "waiting_on_coach"].includes(status)) return;
  await updateThreadStatus(threadId, status);
  await audit("set_thread_status", "support_thread", threadId, null, { status }, staff.id);
  revalidatePath("/support");
}

export async function refundPurchaseAction(formData: FormData) {
  const staff = await staffOrForbidden("billing");
  const purchaseId = text(formData, "purchaseId");
  if (!purchaseId) return;
  const result = await performAuditedRefund({
    purchaseId,
    actorStaffId: staff.id,
    ...(await requestAuditContext()),
    stripeRefund: /^(sk|rk|rkcs)_(test|live)_/.test(process.env.STRIPE_SECRET_KEY ?? "")
      ? async (stripeSessionId: string) => {
          const Stripe = (await import("stripe")).default;
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
          const session = await stripe.checkout.sessions.retrieve(stripeSessionId);
          const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
          if (paymentIntent) await stripe.refunds.create({ payment_intent: paymentIntent });
        }
      : undefined,
  });
  if (!result.audited) return;
  revalidatePath("/commerce");
  revalidatePath("/customers");
}

export async function grantEntitlementAction(formData: FormData) {
  const staff = await staffOrForbidden("billing");
  const userId = text(formData, "userId");
  const courseId = text(formData, "courseId");
  if (!userId || !courseId) return;
  const before = await listEnrollmentsForUser(userId);
  await grantCourseEntitlement(userId, courseId);
  const after = await listEnrollmentsForUser(userId);
  await audit("grant_entitlement", "user", userId, before, after, staff.id);
  revalidatePath("/customers");
}

export async function revokeEntitlementAction(formData: FormData) {
  const staff = await staffOrForbidden("billing");
  const userId = text(formData, "userId");
  const courseId = text(formData, "courseId");
  if (!userId || !courseId) return;
  const before = await listEnrollmentsForUser(userId);
  await revokeCourseEntitlement(userId, courseId);
  const after = await listEnrollmentsForUser(userId);
  await audit("revoke_entitlement", "user", userId, before, after, staff.id);
  revalidatePath("/customers");
}

export async function createStaffAction(formData: FormData) {
  const actor = await staffOrForbidden("staff");
  const email = text(formData, "email").toLowerCase();
  const role = text(formData, "role");
  if (!email || (role !== "super_admin" && role !== "admin" && role !== "support" && role !== "finance")) return;
  const created = await insertStaff({ email, role: role as StaffRole });
  await audit("create_staff", "staff", created.id, null, created, actor.id);
  revalidatePath("/staff");
}

export async function setStaffRoleAction(formData: FormData) {
  const actor = await staffOrForbidden("staff");
  const staffId = text(formData, "staffId");
  const role = text(formData, "role");
  if (!staffId || (role !== "super_admin" && role !== "admin" && role !== "support" && role !== "finance")) return;
  const after = await updateStaffRole(staffId, role as StaffRole);
  await audit("set_staff_role", "staff", staffId, null, after, actor.id);
  revalidatePath("/staff");
}

export async function setStaffStatusAction(formData: FormData) {
  const actor = await staffOrForbidden("staff");
  const staffId = text(formData, "staffId");
  const status = text(formData, "status") === "suspended" ? "suspended" : "active";
  if (!staffId) return;
  const after = await updateStaffStatus(staffId, status as StaffStatus);
  await audit("set_staff_status", "staff", staffId, null, after, actor.id);
  revalidatePath("/staff");
}

export async function hidePostAction(formData: FormData) {
  const staff = await staffOrForbidden("content");
  const postId = text(formData, "postId");
  if (!postId) return;
  const { setCommunityPostStatus } = await import("@syntholo/db");
  await setCommunityPostStatus(postId, "hidden");
  await audit("hide_post", "community_post", postId, { status: "published" }, { status: "hidden" }, staff.id);
  revalidatePath("/community");
}

export async function restorePostAction(formData: FormData) {
  const staff = await staffOrForbidden("content");
  const postId = text(formData, "postId");
  if (!postId) return;
  const { setCommunityPostStatus } = await import("@syntholo/db");
  await setCommunityPostStatus(postId, "published");
  await audit("restore_post", "community_post", postId, { status: "hidden" }, { status: "published" }, staff.id);
  revalidatePath("/community");
}

export async function resolveReportAction(formData: FormData) {
  const staff = await staffOrForbidden("content");
  const reportId = text(formData, "reportId");
  if (!reportId) return;
  const { resolveCommunityReport } = await import("@syntholo/db");
  await resolveCommunityReport(reportId);
  await audit("resolve_report", "community_report", reportId, { status: "open" }, { status: "reviewed" }, staff.id);
  revalidatePath("/community");
}

export async function createSessionAction(formData: FormData) {
  const staff = await staffOrForbidden("content");
  const title = text(formData, "title");
  const startsAt = text(formData, "startsAt");
  if (!title || !startsAt) return;
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const { createLiveSession } = await import("@syntholo/db");
  const id = await createLiveSession({
    title,
    description: text(formData, "description"),
    region: text(formData, "region") || "Americas",
    hostName: text(formData, "hostName") || staffDisplayName(staff),
    startsAt: start,
    endsAt: end,
    joinUrl: text(formData, "joinUrl") || undefined,
  });
  await audit("create_live_session", "live_session", id, null, { title, startsAt }, staff.id);
  revalidatePath("/content");
  revalidatePath("/logs");
}

export async function saveProvisioningNoteAction(formData: FormData) {
  const staff = await staffOrForbidden("support");
  const accountId = text(formData, "accountId");
  const note = text(formData, "note");
  if (!accountId || !note) return;
  const { saveSoftwareNote } = await import("@syntholo/db");
  await saveSoftwareNote(accountId, `${staffDisplayName(staff)}: ${note}`);
  await audit("software_note", "software_account", accountId, null, { note }, staff.id);
  revalidatePath("/provisioning");
}

export async function toggleLaunchCheckAction(formData: FormData) {
  const staff = await staffOrForbidden("support");
  const accountId = text(formData, "accountId");
  const check = text(formData, "check");
  if (!accountId || !check) return;
  const { toggleSoftwareLaunchCheck } = await import("@syntholo/db");
  const after = await toggleSoftwareLaunchCheck(accountId, check);
  await audit("software_launch_check", "software_account", accountId, null, after, staff.id);
  revalidatePath("/provisioning");
}
