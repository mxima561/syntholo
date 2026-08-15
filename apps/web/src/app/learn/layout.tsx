import type { ReactNode } from "react";
import { isDemoMode } from "@/lib/config/mode";
import { ProductionMemberShell } from "@/components/production-member-shell";

export default async function LearnLayout({ children }: { children: ReactNode }) {
  if (!isDemoMode()) return <ProductionMemberShell>{children}</ProductionMemberShell>;
  const [{ MemberShell }, { demoMembers, demoOrganization }] = await Promise.all([
    import("@/components/member-shell"),
    import("@/lib/demo/data"),
  ]);
  const member = demoMembers[0];
  return (
    <MemberShell identity={{
      initials: member.initials,
      memberName: `${member.firstName} ${member.lastName}`,
      organizationName: demoOrganization.name,
      supportEndsLabel: "Jul 30, 2027",
    }}>
      {children}
    </MemberShell>
  );
}
