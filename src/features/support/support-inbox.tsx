"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Clock3, FilePlus2, MessageSquarePlus, Paperclip, Send } from "lucide-react";
import type { SupportThread } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatMessageDate(value: string) {
  const date = new Date(value);
  const hour = date.getUTCHours();
  const displayHour = hour % 12 || 12;
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${monthNames[date.getUTCMonth()]} ${date.getUTCDate()} · ${displayHour}:${minutes} ${hour >= 12 ? "PM" : "AM"}`;
}

export function SupportInbox({ initialThreads }: { initialThreads: SupportThread[] }) {
  const [threads, setThreads] = useState(initialThreads);
  const [selectedId, setSelectedId] = useState(initialThreads[0]?.id);
  const [reply, setReply] = useState("");
  const selected = useMemo(() => threads.find((thread) => thread.id === selectedId) ?? threads[0], [threads, selectedId]);

  function sendReply() {
    const body = reply.trim();
    if (!body) return;
    setThreads((items) => items.map((thread) => thread.id === selected.id ? {
      ...thread,
      status: "waiting_on_coach",
      messages: [...thread.messages, {
        id: `message-${thread.messages.length + 1}`,
        authorId: "member-maria",
        authorName: "Maria Chen",
        authorRole: "customer",
        body,
        createdAt: new Date().toISOString(),
      }],
    } : thread));
    setReply("");
  }

  return (
    <div className="support-inbox">
      <aside className="thread-list">
        <div className="thread-list-head"><div><span className="micro-label">Shared inbox</span><strong>{threads.length} conversations</strong></div><button aria-label="Start a new support conversation" type="button"><MessageSquarePlus size={16} /></button></div>
        {threads.map((thread) => <button className={thread.id === selected.id ? "active" : ""} key={thread.id} onClick={() => setSelectedId(thread.id)} type="button"><span className="coach-avatar">{thread.assignedCoachName.split(" ").map((part) => part[0]).join("")}</span><div><span>{thread.assignedCoachName}<i className={`status-pill ${thread.status}`}>{thread.status.replaceAll("_", " ")}</i></span><strong>{thread.subject}</strong><small>{thread.messages.at(-1)?.body}</small></div></button>)}
      </aside>
      <section className="conversation-panel">
        <header><div><span className="micro-label">{selected.category.replace("_", " ")}</span><h2>{selected.subject}</h2><p>Assigned to {selected.assignedCoachName}</p></div><span className={`conversation-sla ${selected.status === "waiting_on_customer" ? "paused" : ""}`}><Clock3 size={13} /> {selected.status === "waiting_on_customer" ? "SLA paused · your reply" : "Reply due within 2 business days"}</span></header>
        <div className="message-stream">
          {selected.messages.map((message) => <article className={message.authorRole} key={message.id}><span className={message.authorRole === "coach" ? "coach-avatar" : "member-message-avatar"}>{message.authorName.split(" ").map((part) => part[0]).join("")}</span><div><div><strong>{message.authorName}</strong><small>{message.authorRole === "coach" ? "Human coach" : "Northstar Advisory"}</small></div><p>{message.body}</p><time>{formatMessageDate(message.createdAt)}</time></div></article>)}
          {selected.status === "waiting_on_customer" ? <div className="reply-needed"><CheckCircle2 size={15} /> Naomi replied. The response timer is paused until you write back.</div> : null}
        </div>
        <form className="reply-composer" onSubmit={(event) => { event.preventDefault(); sendReply(); }}><label htmlFor="coach-reply">Reply to {selected.assignedCoachName.split(" ")[0]}</label><textarea id="coach-reply" onChange={(event) => setReply(event.target.value)} placeholder="Share context, a decision, or the specific feedback you need…" value={reply} /><div><div><button aria-label="Attach a file" type="button"><Paperclip size={15} /></button><button aria-label="Attach an artifact" type="button"><FilePlus2 size={15} /></button><span>PDF, DOCX, XLSX, CSV, PNG or JPG · 25 MB</span></div><Button disabled={!reply.trim()} size="small" type="submit" variant="human">Send reply <Send size={14} /></Button></div></form>
      </section>
      <aside className="coach-profile"><span className="coach-avatar large">NR</span><span className="online-dot" /><h2>Naomi Reed</h2><p>Implementation coach</p><dl><div><dt>Typical reply</dt><dd>1 business day</dd></div><div><dt>Specialty</dt><dd>Client operations</dd></div></dl><div className="support-standard"><strong>Human support standard</strong><p>Every substantive question receives a real response within two U.S. business days.</p></div></aside>
    </div>
  );
}
