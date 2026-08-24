import type { ReactNode } from "react";
import { MemberShell } from "@/components/member-shell";
import { requireStudentAccount } from "@/lib/server/accounts";
import { getPrimaryCourse, ensureEnrollment } from "@/lib/server/courses";

export const dynamic = "force-dynamic";

export default async function LearnLayout({ children }: { children: ReactNode }) {
  const account = await requireStudentAccount();
  const course = await getPrimaryCourse();
  if (course) await ensureEnrollment(account.id, course.id);

  return (
    <MemberShell
      identity={{
        initials: account.initials,
        name: `${account.firstName} ${account.lastName}`.trim() || account.email,
        subtitle: course?.title ?? "Academy",
      }}
      isAdmin={account.role === "admin"}
    >
      {children}
    </MemberShell>
  );
}
