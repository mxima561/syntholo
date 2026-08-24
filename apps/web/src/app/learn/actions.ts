"use server";

import { revalidatePath } from "next/cache";
import { requireStudentAccount } from "@/lib/server/accounts";
import { setLessonProgress, ensureEnrollment, getPrimaryCourse } from "@/lib/server/courses";

export async function setLessonCompleteAction(lessonId: string, complete: boolean) {
  const account = await requireStudentAccount();
  const course = await getPrimaryCourse();
  if (course) await ensureEnrollment(account.id, course.id);
  await setLessonProgress(account.id, lessonId, complete);
  revalidatePath("/learn", "layout");
  return { ok: true };
}
