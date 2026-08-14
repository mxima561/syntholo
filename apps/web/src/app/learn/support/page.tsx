import { ProductionMemberAccess } from "@/components/production-member-access";
import { isDemoMode } from "@/lib/config/mode";

export default async function SupportPage() {
  if (!isDemoMode()) return <ProductionMemberAccess />;
  const [{ SupportInbox }, { demoMembers, demoOrganization, demoSupportThreads }] = await Promise.all([
    import("@/features/support/support-inbox"),
    import("@/lib/demo/data"),
  ]);
  const member = demoMembers[0];
  return <div className="member-page support-page"><section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Real practitioner support</span><h1>Your human support inbox</h1><p>Your whole team can see the context, questions, files, and coach replies.</p></div></section><SupportInbox currentMember={{ businessName: demoOrganization.name, id: member.id, name: `${member.firstName} ${member.lastName}` }} initialThreads={demoSupportThreads} /></div>;
}
