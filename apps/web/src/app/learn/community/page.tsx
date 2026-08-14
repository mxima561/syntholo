import { CommunityFeed } from "@/features/community/community-feed";
import { ProductionMemberAccess } from "@/components/production-member-access";
import { isDemoMode } from "@/lib/config/mode";
import { demoCommunityPosts } from "@/lib/demo/data";

export default function CommunityPage() {
  if (!isDemoMode()) return <ProductionMemberAccess />;
  return <div className="member-page community-page"><section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Owner community</span><h1>Learn with people doing the work.</h1><p>Share useful wins, compare decisions, and get unstuck without the noise of a public social feed.</p></div></section><CommunityFeed initialPosts={demoCommunityPosts} /></div>;
}
