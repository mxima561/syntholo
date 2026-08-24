"use client";

import { useMemo, useState, useTransition } from "react";
import { CheckCircle2, Clock3, Send } from "lucide-react";
import type { MemberIdentity } from "@/lib/domain/identity";
import { Button } from "@/components/ui/button";
import { createThreadAction, replyToThreadAction } from "@/app/learn/actions";

export type InboxMessage = {
  id: string;
  authorName: string;
  authorRole: "coach" | "customer";
  body: string;
  createdAt: string;
};

export type InboxThread = {
  id: string;
  subject: string;
  category: string;
  status: string;
  coachName: string;
  updatedAt: string;
  messages: InboxMessage[];
};

function formatMessageDate(value: string) {
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function SupportInbox({ threads, identity }: { threads: InboxThread[]; identity: MemberIdentity }) {
  const [selectedId, setSelectedId] = useState(threads[0]?.id);
  const [creating, setCreating] = useState(false);
  const [pending, startTransition] = useTransition();
  const selected = useMemo(() => threads.find((thread) => thread.id === selectedId) ?? threads[0], [threads, selectedId]);

  if (!selected) {
    return <p className="empty-note">Your support inbox will appear here.</p>;
  }

  function startThread(formData: FormData) {
    startTransition(async () => {
      await createThreadAction(formData);
      setCreating(false);
    });
  }

  function sendReply(formData: FormData) {
    startTransition(async () => {
      await replyToThreadAction(formData);
    });
  }

  return (
    <div className="support-inbox">
      <aside className="thread-list">
        <div className="thread-list-head">
          <div><span className="micro-label">Shared inbox</span><strong>{threads.length} conversations</strong></div>
          <button aria-label="Start a new support conversation" onClick={() => setCreating(true)} type="button">＋</button>
        </div>
        {threads.map((thread) => (
          <button className={thread.id === selected.id ? "active" : ""} key={thread.id} onClick={() => setSelectedId(thread.id)} type="button">
            <span className="coach-avatar">{thread.coachName.split(" ").map((part) => part[0]).join("")}</span>
            <div>
              <span>{thread.coachName}<i className={`status-pill ${thread.status}`}>{thread.status.replaceAll("_", " ")}</i></span>
              <strong>{thread.subject}</strong>
              <small>{thread.messages.at(-1)?.body}</small>
            </div>
          </button>
        ))}
      </aside>

      <section className="conversation-panel">
        {creating ? (
          <form action={startThread} className="new-thread-form">
            <div className="admin-panel-head"><div><span className="micro-label">New conversation</span><h2>Ask your coach</h2></div><button aria-label="Close new conversation" onClick={() => setCreating(false)} type="button">✕</button></div>
            <label>Subject<input aria-label="Conversation subject" name="subject" placeholder="e.g. Review my lead-routing rules before launch" required /></label>
            <label>First message<textarea aria-label="First message" name="message" placeholder="Give your coach context: what you are building, what you decided, what feedback you need…" required rows={5} /></label>
            <Button disabled={pending} size="small" variant="human" type="submit">Send to coach <Send size={14} /></Button>
          </form>
        ) : (
          <>
            <header>
              <div>
                <span className="micro-label">{selected.category.replace("_", " ")}</span>
                <h2>{selected.subject}</h2>
                <p>Assigned to {selected.coachName}</p>
              </div>
              <span className={`conversation-sla ${selected.status === "waiting_on_customer" ? "paused" : ""}`}>
                <Clock3 size={13} /> {selected.status === "waiting_on_customer" ? `${selected.coachName.split(" ")[0]} replied · your move` : "Coach replies within 2 business days"}
              </span>
            </header>
            <div className="message-stream">
              {selected.messages.map((message) => (
                <article className={message.authorRole} key={message.id}>
                  <span className={message.authorRole === "coach" ? "coach-avatar" : "member-message-avatar"}>
                    {message.authorName.split(" ").map((part) => part[0]).join("")}
                  </span>
                  <div>
                    <div><strong>{message.authorName}</strong><small>{message.authorRole === "coach" ? "Human coach" : identity.business}</small></div>
                    <p>{message.body}</p>
                    <time>{formatMessageDate(message.createdAt)}</time>
                  </div>
                </article>
              ))}
              {selected.status === "waiting_on_customer" ? (
                <div className="reply-needed"><CheckCircle2 size={15} /> Your coach replied. The ball is in your court.</div>
              ) : null}
            </div>
            <form action={sendReply} className="reply-composer">
              <input name="threadId" type="hidden" value={selected.id} />
              <label htmlFor="coach-reply">Reply to {selected.coachName.split(" ")[0]}</label>
              <textarea aria-label="Reply body" id="coach-reply" name="body" placeholder="Share context, a decision, or the specific feedback you need…" required />
              <div>
                <div><span>Replies go straight to your coach queue</span></div>
                <Button disabled={pending} size="small" type="submit" variant="human">Send reply <Send size={14} /></Button>
              </div>
            </form>
          </>
        )}
      </section>

      <aside className="coach-profile">
        <span className="coach-avatar large">{selected.coachName.split(" ").map((part) => part[0]).join("")}</span>
        <span className="online-dot" />
        <h2>{selected.coachName}</h2>
        <p>Implementation coach</p>
        <dl>
          <div><dt>Typical reply</dt><dd>1 business day</dd></div>
          <div><dt>Specialty</dt><dd>Client operations</dd></div>
        </dl>
        <div className="support-standard">
          <strong>Human support standard</strong>
          <p>Every substantive question receives a real response within two U.S. business days.</p>
        </div>
      </aside>
    </div>
  );
}
