"use server";

import { revalidatePath } from "next/cache";
import { requireStudentAccount } from "@/lib/server/accounts";
import {
  setLessonProgress,
  ensureEnrollment,
  getPrimaryCourse,
} from "@/lib/server/courses";
import { createCommunityPost, toggleCommunityReaction } from "@/lib/server/community";
import { createSupportThread, addCustomerReply } from "@/lib/server/support";

export async function setLessonCompleteAction(lessonId: string, complete: boolean) {
  const account = await requireStudentAccount();
  const course = await getPrimaryCourse();
  if (course) await ensureEnrollment(account.id, course.id);
  await setLessonProgress(account.id, lessonId, complete);
  revalidatePath("/learn", "layout");
  return { ok: true };
}

export async function createPostAction(formData: FormData) {
  const account = await requireStudentAccount();
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const space = String(formData.get("space") ?? "Implementation Wins").trim() || "Implementation Wins";
  if (!title || !body) return;
  await createCommunityPost({
    authorId: account.id,
    authorName: `${account.firstName} ${account.lastName}`.trim() || account.email,
    authorBusiness: "Member workspace",
    initials: account.initials,
    space,
    title,
    body,
  });
  revalidatePath("/learn/community");
}

export async function toggleLikeAction(postId: string) {
  const account = await requireStudentAccount();
  const result = await toggleCommunityReaction(postId, account.id);
  revalidatePath("/learn/community");
  return result;
}

export async function createThreadAction(formData: FormData) {
  const account = await requireStudentAccount();
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("message") ?? "").trim();
  if (!subject || !body) return;
  await createSupportThread({
    userId: account.id,
    subject,
    firstMessage: body,
    authorName: `${account.firstName} ${account.lastName}`.trim() || account.email,
  });
  revalidatePath("/learn/support");
}

export async function replyToThreadAction(formData: FormData) {
  const account = await requireStudentAccount();
  const threadId = String(formData.get("threadId") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!threadId || !body) return;
  await addCustomerReply({
    threadId,
    userId: account.id,
    authorName: `${account.firstName} ${account.lastName}`.trim() || account.email,
    body,
  });
  revalidatePath("/learn/support");
}
