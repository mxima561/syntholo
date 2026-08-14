"use client";

import { useState } from "react";
import { Flag, Heart, MessageCircle, Plus, Send, X } from "lucide-react";
import type { CommunityPost } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";

const spaces = ["All spaces", "Start Here", "Implementation Wins", "Growth Engine", "Client Engine", "Management Engine", "Tool Questions", "Announcements"];

function relativeDay(createdAt: string, referenceTime: string) {
  const days = -Math.max(1, Math.round((new Date(referenceTime).getTime() - new Date(createdAt).getTime()) / 86_400_000));
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(days, "day");
}

type CurrentMember = Pick<CommunityPost, "authorName" | "authorRole" | "businessName" | "initials">;

export function CommunityFeed({
  currentMember,
  initialPosts,
  referenceTime,
}: {
  currentMember: CurrentMember;
  initialPosts: CommunityPost[];
  referenceTime: string;
}) {
  const [posts, setPosts] = useState(initialPosts);
  const [space, setSpace] = useState("All spaces");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [liked, setLiked] = useState<string[]>([]);
  const visible = space === "All spaces" ? posts : posts.filter((post) => post.space === space);

  function publish() {
    if (!title.trim() || !body.trim()) return;
    setPosts((items) => [{ id: `post-${items.length + 1}`, space: space === "All spaces" ? "Implementation Wins" : space, ...currentMember, title: title.trim(), body: body.trim(), createdAt: new Date().toISOString(), commentCount: 0, reactionCount: 0, status: "published" }, ...items]);
    setTitle(""); setBody(""); setCreating(false);
  }

  return (
    <div className="community-layout">
      <aside className="space-list"><span className="micro-label">Spaces</span>{spaces.map((item) => <button className={space === item ? "active" : ""} key={item} onClick={() => setSpace(item)} type="button"><span /> {item}</button>)}</aside>
      <section className="community-feed">
        <button className="create-post-prompt" onClick={() => setCreating(true)} type="button"><span className="member-message-avatar">{currentMember.initials}</span><span>Share a decision, question, or implementation win…</span><i><Plus size={14} /> Share an update</i></button>
        {creating ? <form className="create-post-form" onSubmit={(event) => { event.preventDefault(); publish(); }}><div><span className="micro-label">Post as {currentMember.authorName}</span><button aria-label="Close post composer" onClick={() => setCreating(false)} type="button"><X size={16} /></button></div><label>Post title<input aria-label="Post title" onChange={(event) => setTitle(event.target.value)} placeholder="What did you learn or decide?" value={title} /></label><label>Post body<textarea aria-label="Post body" onChange={(event) => setBody(event.target.value)} placeholder="Give other owners enough context to help…" value={body} /></label><div><select aria-label="Community space" onChange={(event) => setSpace(event.target.value)} value={space === "All spaces" ? "Implementation Wins" : space}>{spaces.slice(1).map((item) => <option key={item}>{item}</option>)}</select><Button disabled={!title.trim() || !body.trim()} size="small" type="submit">Publish post <Send size={14} /></Button></div></form> : null}
        <div className="post-list">{visible.map((post) => <article className="community-post" key={post.id}><header><span className="member-message-avatar">{post.initials}</span><div><strong>{post.authorName}</strong><span>{post.authorRole} · {post.businessName}</span></div><i>{post.space}</i></header><h2>{post.title}</h2><p>{post.body}</p><footer><button className={liked.includes(post.id) ? "liked" : ""} onClick={() => setLiked((items) => items.includes(post.id) ? items.filter((id) => id !== post.id) : [...items, post.id])} type="button"><Heart fill={liked.includes(post.id) ? "currentColor" : "none"} size={14} /> {post.reactionCount + Number(liked.includes(post.id))}</button><button type="button"><MessageCircle size={14} /> {post.commentCount} comments</button><time>{relativeDay(post.createdAt, referenceTime)}</time><button aria-label={`Report ${post.title}`} type="button"><Flag size={13} /></button></footer></article>)}</div>
      </section>
      <aside className="community-rail"><div><span className="micro-label">This week</span><strong>247</strong><p>owners learning together</p></div><div><span className="micro-label">Community standard</span><h2>Useful, specific, generous.</h2><p>Use your real name and business. Share the process—not private client data.</p></div><div><span className="micro-label">Popular now</span><ol><li>Human review points</li><li>Lead routing edge cases</li><li>Weekly owner briefs</li></ol></div></aside>
    </div>
  );
}
