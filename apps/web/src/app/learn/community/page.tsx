import { CommunityFeed } from "@/features/community/community-feed";
import { requireStudentAccount } from "@/lib/server/accounts";
import { listCommunityPosts } from "@/lib/server/community";

export const dynamic = "force-dynamic";

export default async function CommunityPage() {
  const account = await requireStudentAccount();
  const posts = await listCommunityPosts(account.id);

  return (
    <div className="member-page community-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" /> Owner community</span>
          <h1>Learn with people doing the work.</h1>
          <p>Share useful wins, compare decisions, and get unstuck without the noise of a public social feed.</p>
        </div>
      </section>
      <CommunityFeed
        identity={{
          name: `${account.firstName} ${account.lastName}`.trim() || account.email,
          initials: account.initials,
          business: "Member workspace",
        }}
        initialPosts={posts.map((post) => ({
          id: post.id,
          authorName: post.authorName,
          authorBusiness: post.authorBusiness,
          initials: post.initials,
          space: post.space,
          title: post.title,
          body: post.body,
          reactionCount: post.reactionCount,
          commentCount: post.commentCount,
          createdAt: post.createdAt.toISOString(),
          likedByViewer: post.likedByViewer,
        }))}
      />
    </div>
  );
}
