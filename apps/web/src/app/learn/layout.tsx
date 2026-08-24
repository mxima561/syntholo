import type { ReactNode } from "react";
import { MemberShell } from "@/components/member-shell";
import { isClerkConfigured, requireAcademyAccount } from "@/lib/server/accounts";
import { getPrimaryCourse, ensureEnrollment } from "@/lib/server/courses";
import { ensureWelcomeThread } from "@/lib/server/support";

export const dynamic = "force-dynamic";

export default async function LearnLayout({ children }: { children: ReactNode }) {
  const account = await requireAcademyAccount();
  const course = await getPrimaryCourse();
  if (course) {
    await ensureEnrollment(account.id, course.id);
    await ensureWelcomeThread(account.id, account.firstName);
  }

  return (
    <MemberShell
      identity={{
        initials: account.initials,
        name: `${account.firstName} ${account.lastName}`.trim() || account.email,
        subtitle: `${course?.title ?? "Academy"} · ${account.publicId}`,
        authLabel: isClerkConfigured() ? "Signed in with Clerk" : "Local student session",
      }}
    >
      {children}
    </MemberShell>
  );
}
