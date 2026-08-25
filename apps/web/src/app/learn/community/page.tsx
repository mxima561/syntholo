import { CommunityFeed } from "@/features/community/community-feed";
import { requireAcademyAccess } from "@/lib/server/accounts";
import { listCommunityPosts } from "@/lib/server/community";
import { listCommentsForPosts } from "@syntholo/db";

export const dynamic = "force-dynamic";

export default async function CommunityPage() {
  const { account, access } = await requireAcademyAccess();
  const posts = await listCommunityPosts(account.id);
  const comments = await listCommentsForPosts(posts.map((post) => post.id));
  const commentsByPost = new Map<string, typeof comments>();
  for (const comment of comments) {
    const list = commentsByPost.get(comment.postId) ?? [];
    list.push(comment);
    commentsByPost.set(comment.postId, list);
  }

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
        canWrite={access.capabilities.circle_write}
        identity={{
          name: `${account.firstName} ${account.lastName}`.trim() || account.email,
          initials: account.initials,
          business: account.businessName || "Member workspace",
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
          comments: (commentsByPost.get(post.id) ?? []).map((comment) => ({
            id: comment.id,
            authorName: comment.authorName,
            initials: comment.initials,
            body: comment.body,
            createdAt: comment.createdAt.toISOString(),
          })),
        }))}
      />
    </div>
  );
}
