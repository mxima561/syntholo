import { hidePostAction, resolveReportAction, restorePostAction } from "@/app/actions";
import { requireStaff } from "@/lib/auth/staff";
import { listAllCommunityPosts, listCommunityReports } from "@syntholo/db";

export const dynamic = "force-dynamic";

export default async function AdminCommunityPage() {
  await requireStaff();
  const [posts, reports] = await Promise.all([listAllCommunityPosts(), listCommunityReports()]);

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Trust and moderation</span>
          <h1>Community</h1>
          <p>Live posts and open reports. Hide, restore, and resolve with an audit trail.</p>
        </div>
      </section>
      <section className="admin-table">
        <header><span>Report</span><span>Post</span><span>Reason</span><span>Opened</span><span /></header>
        {reports.length === 0 ? <p className="empty-note">No open reports.</p> : reports.map((report) => (
          <div className="student-row" key={report.id}>
            <strong>{report.id.slice(0, 8)}</strong>
            <span>{report.postTitle}</span>
            <span>{report.reason}</span>
            <span>{report.createdAt.toLocaleDateString("en-US")}</span>
            <form action={resolveReportAction}>
              <input name="reportId" type="hidden" value={report.id} />
              <button className="button button-secondary button-small" type="submit">Mark reviewed</button>
            </form>
          </div>
        ))}
      </section>
      <section className="admin-table">
        <header><span>Post</span><span>Author</span><span>Space</span><span>Status</span><span /></header>
        {posts.length === 0 ? <p className="empty-note">No community posts yet.</p> : posts.map((post) => (
          <div className="student-row" key={String(post.id)}>
            <strong>{String(post.title)}</strong>
            <span>{String(post.author_name)}</span>
            <span>{String(post.space)}</span>
            <i className={`status-pill ${post.status === "published" ? "live" : "paused"}`}>{String(post.status)}</i>
            {post.status === "hidden" ? (
              <form action={restorePostAction}>
                <input name="postId" type="hidden" value={String(post.id)} />
                <button className="button button-secondary button-small" type="submit">Restore</button>
              </form>
            ) : (
              <form action={hidePostAction}>
                <input name="postId" type="hidden" value={String(post.id)} />
                <button className="button button-secondary button-small" type="submit">Hide</button>
              </form>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
