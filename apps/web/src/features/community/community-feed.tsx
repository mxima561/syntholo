"use client";

import { useState, useTransition } from "react";
import { Flag, Heart, MessageCircle, Plus, Send, X } from "lucide-react";
import type { MemberIdentity } from "@/lib/domain/identity";
import { Button } from "@/components/ui/button";
import { commentOnPostAction, createPostAction, reportPostAction, toggleLikeAction } from "@/app/learn/actions";

export type FeedComment = {
  id: string;
  authorName: string;
  initials: string;
  body: string;
  createdAt: string;
};

export type FeedPost = {
  id: string;
  authorName: string;
  authorBusiness: string;
  initials: string;
  space: string;
  title: string;
  body: string;
  reactionCount: number;
  commentCount: number;
  createdAt: string;
  likedByViewer: boolean;
  comments: FeedComment[];
};

const spaces = ["All spaces", "Start Here", "Implementation Wins", "Growth Engine", "Client Engine", "Management Engine", "Tool Questions", "Announcements"];

function relativeDay(createdAt: string) {
  const days = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 86_400_000));
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-days, "day");
}

export function CommunityFeed({
  initialPosts,
  identity,
  canWrite = true,
}: {
  initialPosts: FeedPost[];
  identity: MemberIdentity;
  canWrite?: boolean;
}) {
  const [posts, setPosts] = useState(initialPosts);
  const [space, setSpace] = useState("All spaces");
  const [creating, setCreating] = useState(false);
  const [openComments, setOpenComments] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  const visible = space === "All spaces" ? posts : posts.filter((post) => post.space === space);

  function publish(formData: FormData) {
    startTransition(async () => {
      await createPostAction(formData);
      setTitle("");
      setBody("");
      setCreating(false);
    });
  }

  function like(postId: string) {
    const current = posts.find((post) => post.id === postId);
    if (!current) return;
    const willLike = !current.likedByViewer;
    setPosts((items) => items.map((post) => post.id === postId
      ? { ...post, likedByViewer: willLike, reactionCount: post.reactionCount + (willLike ? 1 : -1) }
      : post));
    startTransition(async () => {
      const result = await toggleLikeAction(postId);
      setPosts((items) => items.map((post) => post.id === postId
        ? { ...post, likedByViewer: result.liked, reactionCount: result.reactionCount }
        : post));
    });
  }

  return (
    <div className="community-layout">
      <aside className="space-list"><span className="micro-label">Spaces</span>{spaces.map((item) => <button className={space === item ? "active" : ""} key={item} onClick={() => setSpace(item)} type="button"><span /> {item}</button>)}</aside>
      <section className="community-feed">
        {canWrite ? (
          <button className="create-post-prompt" onClick={() => setCreating(true)} type="button"><span className="member-message-avatar">{identity.initials}</span><span>Share a decision, question, or implementation win…</span><i><Plus size={14} /> Share an update</i></button>
        ) : (
          <p className="empty-note">Community posting is not included on this account. You can still read the feed.</p>
        )}
        {creating && canWrite ? (
          <form action={publish} className="create-post-form">
            <div>
              <span className="micro-label">Posting as {identity.name}</span>
              <button aria-label="Close post composer" onClick={() => setCreating(false)} type="button"><X size={16} /></button>
            </div>
            <label>Post title<input aria-label="Post title" name="title" onChange={(event) => setTitle(event.target.value)} placeholder="What did you learn or decide?" required value={title} /></label>
            <label>Post body<textarea aria-label="Post body" name="body" onChange={(event) => setBody(event.target.value)} placeholder="Give other owners enough context to help…" required value={body} /></label>
            <div>
              <select aria-label="Community space" defaultValue="Implementation Wins" name="space">{spaces.slice(1).map((item) => <option key={item}>{item}</option>)}</select>
              <Button disabled={pending || !title.trim() || !body.trim()} size="small" type="submit">Publish post <Send size={14} /></Button>
            </div>
          </form>
        ) : null}
        {visible.length === 0 ? (
          <p className="empty-note">No posts in this space yet — be the first to share a win.</p>
        ) : (
          <div className="post-list">{visible.map((post) => (
            <article className="community-post" key={post.id}>
              <header>
                <span className="member-message-avatar">{post.initials}</span>
                <div><strong>{post.authorName}</strong><span>{post.authorBusiness}</span></div>
                <i>{post.space}</i>
              </header>
              <h2>{post.title}</h2>
              <p>{post.body}</p>
              <footer>
                <button className={post.likedByViewer ? "liked" : ""} disabled={pending || !canWrite} onClick={() => like(post.id)} type="button"><Heart fill={post.likedByViewer ? "currentColor" : "none"} size={14} /> {post.reactionCount}</button>
                <button onClick={() => setOpenComments(openComments === post.id ? null : post.id)} type="button"><MessageCircle size={14} /> {post.commentCount} comments</button>
                <time>{relativeDay(post.createdAt)}</time>
                <button aria-label={`Report ${post.title}`} disabled={pending || !canWrite} onClick={() => { startTransition(() => { void reportPostAction(post.id); }); }} type="button"><Flag size={13} /></button>
              </footer>
              {openComments === post.id ? (
                <div className="comment-thread">
                  {post.comments.length === 0 ? <p className="empty-note">No comments yet.</p> : post.comments.map((comment) => (
                    <article key={comment.id}>
                      <span className="member-message-avatar">{comment.initials}</span>
                      <div><strong>{comment.authorName}</strong><p>{comment.body}</p></div>
                    </article>
                  ))}
                  {canWrite ? (
                  <form action={(formData) => startTransition(async () => {
                    await commentOnPostAction(formData);
                    const text = String(formData.get("body") ?? "").trim();
                    if (!text) return;
                    setPosts((items) => items.map((item) => item.id === post.id
                      ? { ...item, commentCount: item.commentCount + 1, comments: [...item.comments, { id: `local-${Date.now()}`, authorName: identity.name, initials: identity.initials, body: text, createdAt: new Date().toISOString() }] }
                      : item));
                  })}>
                    <input name="postId" type="hidden" value={post.id} />
                    <label>Write a comment<input name="body" placeholder="Add a specific, useful comment" required /></label>
                    <Button disabled={pending} size="small" type="submit">Comment</Button>
                  </form>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))}</div>
        )}
      </section>
      <aside className="community-rail">
        <div><span className="micro-label">This week</span><strong>{new Set(posts.map((post) => post.authorName)).size}</strong><p>owners learning together</p></div>
        <div><span className="micro-label">Community standard</span><h2>Useful, specific, generous.</h2><p>Use your real name and business. Share the process—not private client data.</p></div>
      </aside>
    </div>
  );
}
