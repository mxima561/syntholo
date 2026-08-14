import { ProductionMemberAccess } from "@/components/production-member-access";
import { isDemoMode } from "@/lib/config/mode";

export default async function CommunityPage() {
  if (!isDemoMode()) return <ProductionMemberAccess />;
  const [{ CommunityFeed }, { demoCommunityPosts, demoMembers, demoOrganization }] = await Promise.all([
    import("@/features/community/community-feed"),
    import("@/lib/demo/data"),
  ]);
  const member = demoMembers[0];
  return <div className="member-page community-page"><section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Owner community</span><h1>Learn with people doing the work.</h1><p>Share useful wins, compare decisions, and get unstuck without the noise of a public social feed.</p></div></section><CommunityFeed currentMember={{ authorName: `${member.firstName} ${member.lastName}`, authorRole: member.title, businessName: demoOrganization.name, initials: member.initials }} initialPosts={demoCommunityPosts} referenceTime="2026-08-11T20:00:00.000Z" /></div>;
}
