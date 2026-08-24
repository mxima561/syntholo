"use server";

import { revalidatePath } from "next/cache";
import { writeActivityEvent } from "@syntholo/db";
import {
  addCommunityComment,
  createWorkflow,
  getCertificate,
  issueCertificateIfEligible,
  reportCommunityPost,
  rsvpLiveSession,
  saveArtifact,
  setWorkflowStatus,
  submitSoftwareProvisioning,
  toggleSoftwareChecklist,
  updateStudentProfile,
  updateWorkflow,
  type WorkflowEngine,
  type WorkflowStatus,
} from "@syntholo/db";
import { requireAcademyAccount, type Account } from "@/lib/server/accounts";
import {
  setLessonProgress,
  ensureEnrollment,
  getPrimaryCourse,
} from "@/lib/server/courses";
import { createCommunityPost, toggleCommunityReaction } from "@/lib/server/community";
import { createSupportThread, addCustomerReply } from "@/lib/server/support";

async function logStudent(
  account: Account,
  action: string,
  targetType: string,
  targetId: string,
  summary: string,
  metadata?: unknown,
) {
  await writeActivityEvent({
    actorKind: "student",
    actorId: account.id,
    actorLabel: `${account.firstName} ${account.lastName}`.trim() || account.email,
    actorPublicId: account.publicId,
    action,
    targetType,
    targetId,
    summary,
    metadata,
  });
}

function displayName(account: Account) {
  return `${account.firstName} ${account.lastName}`.trim() || account.email;
}

export async function setLessonCompleteAction(lessonId: string, complete: boolean) {
  const account = await requireAcademyAccount();
  const course = await getPrimaryCourse();
  if (course) await ensureEnrollment(account.id, course.id);
  await setLessonProgress(account.id, lessonId, complete);
  await logStudent(
    account,
    complete ? "lesson_completed" : "lesson_reopened",
    "lesson",
    lessonId,
    `${displayName(account)} ${complete ? "completed" : "reopened"} lesson ${lessonId}`,
  );
  if (complete && course) {
    const alreadyIssued = await getCertificate(account.id, course.id);
    const certificate = alreadyIssued ?? (await issueCertificateIfEligible(account.id, course.id));
    if (!alreadyIssued && certificate) {
      await logStudent(account, "certificate_issued", "certificate", certificate.id, `${displayName(account)} earned a course certificate`);
    }
  }
  revalidatePath("/learn", "layout");
  return { ok: true };
}

export async function createPostAction(formData: FormData) {
  const account = await requireAcademyAccount();
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const space = String(formData.get("space") ?? "Implementation Wins").trim() || "Implementation Wins";
  if (!title || !body) return;
  const postId = await createCommunityPost({
    authorId: account.id,
    authorName: displayName(account),
    authorBusiness: account.businessName || "Member workspace",
    initials: account.initials,
    space,
    title,
    body,
  });
  await logStudent(account, "community_post", "community_post", postId, `${displayName(account)} posted “${title}” in ${space}`);
  revalidatePath("/learn/community");
}

export async function toggleLikeAction(postId: string) {
  const account = await requireAcademyAccount();
  const result = await toggleCommunityReaction(postId, account.id);
  await logStudent(account, result.liked ? "community_like" : "community_unlike", "community_post", postId, `${displayName(account)} ${result.liked ? "liked" : "unliked"} a post`);
  revalidatePath("/learn/community");
  return result;
}

export async function commentOnPostAction(formData: FormData) {
  const account = await requireAcademyAccount();
  const postId = String(formData.get("postId") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!postId || !body) return;
  await addCommunityComment({
    postId,
    authorId: account.id,
    authorName: displayName(account),
    initials: account.initials,
    body,
  });
  await logStudent(account, "community_comment", "community_post", postId, `${displayName(account)} commented on a post`);
  revalidatePath("/learn/community");
}

export async function reportPostAction(postId: string) {
  const account = await requireAcademyAccount();
  await reportCommunityPost(postId, account.id, "reported_by_member");
  await logStudent(account, "community_report", "community_post", postId, `${displayName(account)} reported a post`);
  revalidatePath("/learn/community");
  return { ok: true };
}

export async function createThreadAction(formData: FormData) {
  const account = await requireAcademyAccount();
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("message") ?? "").trim();
  if (!subject || !body) return;
  await createSupportThread({
    userId: account.id,
    subject,
    firstMessage: body,
    authorName: displayName(account),
  });
  await logStudent(account, "support_thread", "support_thread", subject, `${displayName(account)} opened support: ${subject}`);
  revalidatePath("/learn/support");
}

export async function replyToThreadAction(formData: FormData) {
  const account = await requireAcademyAccount();
  const threadId = String(formData.get("threadId") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!threadId || !body) return;
  await addCustomerReply({
    threadId,
    userId: account.id,
    authorName: displayName(account),
    body,
  });
  await logStudent(account, "support_reply", "support_thread", threadId, `${displayName(account)} replied in support`);
  revalidatePath("/learn/support");
}

export async function saveArtifactAction(formData: FormData) {
  const account = await requireAcademyAccount();
  const artifactId = String(formData.get("artifactId") ?? "").trim();
  const body = String(formData.get("body") ?? "");
  const finalize = String(formData.get("finalize") ?? "") === "1";
  if (!artifactId) return;
  const saved = await saveArtifact({
    artifactId,
    userId: account.id,
    body,
    updatedBy: displayName(account),
    finalize,
  });
  if (saved) {
    await logStudent(
      account,
      finalize ? "artifact_finalized" : "artifact_saved",
      "artifact",
      saved.id,
      `${displayName(account)} ${finalize ? "finalized" : "saved"} ${saved.title}`,
    );
  }
  revalidatePath("/learn", "layout");
}

export async function requestArtifactReviewAction(formData: FormData) {
  const account = await requireAcademyAccount();
  const artifactId = String(formData.get("artifactId") ?? "").trim();
  const body = String(formData.get("body") ?? "");
  const question = String(formData.get("question") ?? "").trim() || "Please review this version.";
  if (!artifactId) return;
  const saved = await saveArtifact({
    artifactId,
    userId: account.id,
    body,
    updatedBy: displayName(account),
    requestReview: true,
  });
  if (saved) {
    await createSupportThread({
      userId: account.id,
      subject: `Review: ${saved.title}`,
      category: "artifact_review",
      firstMessage: `${question}\n\n---\n${saved.body.slice(0, 4000)}`,
      authorName: displayName(account),
    });
    await logStudent(account, "artifact_review_requested", "artifact", saved.id, `${displayName(account)} asked a coach to review ${saved.title}`);
  }
  revalidatePath("/learn", "layout");
}

export async function createWorkflowAction(formData: FormData) {
  const account = await requireAcademyAccount();
  const name = String(formData.get("name") ?? "").trim();
  const engine = String(formData.get("engine") ?? "growth") as WorkflowEngine;
  if (!name) return;
  const workflow = await createWorkflow({
    userId: account.id,
    name,
    engine: engine === "client" || engine === "management" ? engine : "growth",
    owner: displayName(account),
  });
  await logStudent(account, "workflow_created", "workflow", workflow.id, `${displayName(account)} created workflow ${name}`);
  revalidatePath("/learn/workflows");
}

export async function saveWorkflowAction(formData: FormData) {
  const account = await requireAcademyAccount();
  const workflowId = String(formData.get("workflowId") ?? "").trim();
  if (!workflowId) return;
  const saved = await updateWorkflow({
    workflowId,
    userId: account.id,
    name: String(formData.get("name") ?? "").trim(),
    problem: String(formData.get("problem") ?? ""),
    owner: String(formData.get("owner") ?? displayName(account)),
    humanReviewPoint: String(formData.get("humanReviewPoint") ?? ""),
    baseline: String(formData.get("baseline") ?? ""),
    target: String(formData.get("target") ?? ""),
    approvedTools: String(formData.get("approvedTools") ?? ""),
  });
  if (saved) {
    await logStudent(account, "workflow_updated", "workflow", saved.id, `${displayName(account)} updated ${saved.name}`);
  }
  revalidatePath("/learn/workflows");
}

export async function setWorkflowStatusAction(workflowId: string, status: WorkflowStatus) {
  const account = await requireAcademyAccount();
  const saved = await setWorkflowStatus({ workflowId, userId: account.id, status });
  if (saved) {
    await logStudent(account, "workflow_status", "workflow", saved.id, `${displayName(account)} moved ${saved.name} to ${status}`);
  }
  revalidatePath("/learn/workflows");
  return saved;
}

export async function rsvpSessionAction(sessionId: string) {
  const account = await requireAcademyAccount();
  const created = await rsvpLiveSession(sessionId, account.id);
  if (created) {
    await logStudent(account, "session_rsvp", "live_session", sessionId, `${displayName(account)} reserved a live session seat`);
  }
  revalidatePath("/learn/live");
  return { reserved: true };
}

export async function toggleSoftwareItemAction(itemId: string) {
  const account = await requireAcademyAccount();
  await toggleSoftwareChecklist(account.id, itemId);
  await logStudent(account, "business_os_checklist", "software_account", itemId, `${displayName(account)} updated Business OS setup: ${itemId}`);
}

export async function submitSoftwareAction() {
  const account = await requireAcademyAccount();
  const result = await submitSoftwareProvisioning(account.id);
  if (result?.status === "provisioning") {
    await logStudent(account, "business_os_submitted", "software_account", result.id, `${displayName(account)} submitted Business OS for provisioning`);
  }
  revalidatePath("/learn/business-os");
  return result;
}

export async function updateProfileAction(formData: FormData) {
  const account = await requireAcademyAccount();
  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  if (!firstName) return;
  await updateStudentProfile({
    userId: account.id,
    firstName,
    lastName,
    businessName: String(formData.get("businessName") ?? "").trim(),
    jobTitle: String(formData.get("jobTitle") ?? "").trim(),
    timezone: String(formData.get("timezone") ?? "America/New_York").trim() || "America/New_York",
  });
  await logStudent(account, "profile_updated", "user", account.id, `${firstName} ${lastName} updated their profile`);
  revalidatePath("/learn", "layout");
}
