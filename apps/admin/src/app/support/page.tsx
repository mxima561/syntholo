import { notFound } from "next/navigation";
import { Send } from "lucide-react";
import Link from "next/link";
import { coachReplyAction, setThreadStatusAction } from "@/app/actions";
import { requireStaff } from "@/lib/auth/staff";
import { getThreadMessages, listAllThreads, type SupportThreadSummary } from "@/lib/server/support";

export const dynamic = "force-dynamic";

const statusOptions: Array<{ value: SupportThreadSummary["status"]; label: string }> = [
  { value: "waiting_on_coach", label: "Reopen" },
  { value: "resolved", label: "Resolve" },
  { value: "closed", label: "Close" },
];

export default async function AdminSupportPage({ searchParams }: { searchParams: Promise<{ thread?: string }> }) {
  await requireStaff("support");
  const [{ thread }, threads] = await Promise.all([searchParams, listAllThreads()]);

  const selected = threads.find((candidate) => candidate.id === thread) ?? threads[0];
  if (!selected) {
    return (
      <div className="admin-page">
        <section className="admin-page-head"><div><span className="micro-label">Coach operations</span><h1>Support queue</h1><p>Student conversations appear here the moment they write in.</p></div></section>
        <p className="empty-note">No support conversations yet.</p>
      </div>
    );
  }

  const messages = await getThreadMessages(selected.id);

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Coach operations</span>
          <h1>Support queue</h1>
          <p>Answer students directly — replies land in their inbox instantly.</p>
        </div>
      </section>

      <div className="support-admin-layout">
        <aside className="admin-thread-list">
          {threads.map((candidate) => (
            <Link
              className={`admin-thread-row ${candidate.id === selected.id ? "active" : ""} ${["new", "waiting_on_coach"].includes(candidate.status) ? "attention" : ""}`}
              href={`/support?thread=${candidate.id}`}
              key={candidate.id}
            >
              <strong>{candidate.subject}</strong>
              <small>{candidate.studentName || candidate.studentEmail}</small>
              <i className={`status-pill ${candidate.status}`}>{candidate.status.replaceAll("_", " ")}</i>
            </Link>
          ))}
        </aside>

        <section className="content-editor-panel admin-conversation">
          <header>
            <div>
              <span className="micro-label">{selected.category.replace("_", " ")}</span>
              <h2>{selected.subject}</h2>
              <p>{selected.studentName || selected.studentEmail} · {selected.studentEmail} · updated {selected.updatedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
            </div>
            <form action={setThreadStatusAction} className="status-controls">
              {statusOptions.filter((option) => option.value !== selected.status).map((option) => (
                <div key={option.value}>
                  <input name="threadId" type="hidden" value={selected.id} />
                  <input name="status" type="hidden" value={option.value} />
                  <button className="button button-secondary button-small" type="submit">{option.label}</button>
                </div>
              ))}
            </form>
          </header>

          <div className="message-stream">
            {messages.map((message) => (
              <article className={message.authorRole === "coach" ? "coach" : "customer"} key={message.id}>
                <span className={message.authorRole === "coach" ? "coach-avatar" : "member-message-avatar"}>
                  {message.authorName.split(" ").map((part) => part[0]).join("")}
                </span>
                <div>
                  <div><strong>{message.authorName}</strong><small>{message.authorRole === "coach" ? "Coach reply" : "Student"}</small></div>
                  <p>{message.body}</p>
                  <time>{message.createdAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
                </div>
              </article>
            ))}
          </div>

          <form action={coachReplyAction} className="reply-composer">
            <input name="threadId" type="hidden" value={selected.id} />
            <label htmlFor="admin-reply">Reply as {selected.coachName.split(" ")[0]} (coach)</label>
            <textarea aria-label="Coach reply body" id="admin-reply" name="body" placeholder="Write a specific, actionable response…" required />
            <div>
              <div><span>Sent to the student inbox</span></div>
              <button className="button button-human button-small" type="submit">Send reply <Send size={14} /></button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
