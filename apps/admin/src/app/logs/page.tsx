import { Search } from "lucide-react";
import Link from "next/link";
import { requireStaff } from "@/lib/auth/staff";
import { listActivityEvents, listDistinctActivityActions } from "@syntholo/db";

export const dynamic = "force-dynamic";

export default async function AdminLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; action?: string }>;
}) {
  await requireStaff();
  const { q, action } = await searchParams;
  const [events, actions] = await Promise.all([
    listActivityEvents({ q, action: action || undefined, limit: 200 }),
    listDistinctActivityActions(),
  ]);

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Audit trail</span>
          <h1>Logs</h1>
          <p>Every student action, staff mutation, purchase, and system event. Search by student ID, staff email, action, or target.</p>
        </div>
        <form className="admin-search-row" method="get">
          <label className="admin-search">
            <Search size={14} />
            <span className="sr-only">Search logs</span>
            <input aria-label="Search logs" defaultValue={q} name="q" placeholder="Student ID, email, action…" />
          </label>
          <select aria-label="Filter by action" defaultValue={action ?? ""} name="action">
            <option value="">All actions</option>
            {actions.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
          </select>
          <button className="button button-secondary button-small" type="submit">Filter</button>
        </form>
      </section>
      <section className="admin-table log-table">
        <header><span>When</span><span>Actor</span><span>Action</span><span>Summary</span><span>Target</span></header>
        {events.length === 0 ? (
          <p className="empty-note">No matching events yet. Complete a lesson, post in community, or save a document to see rows appear.</p>
        ) : events.map((event) => (
          <div className="log-row" key={event.id}>
            <time dateTime={event.createdAt.toISOString()}>{event.createdAt.toLocaleString("en-US")}</time>
            <div>
              <strong>{event.actorPublicId ?? event.actorKind}</strong>
              <small>{event.actorLabel}</small>
              {event.actorKind === "student" && event.actorId ? (
                <Link href={`/customers/${event.actorId}`}>Open student</Link>
              ) : null}
            </div>
            <code>{event.action}</code>
            <span>{event.summary}</span>
            <span>{event.targetType} · {event.targetId.slice(0, 16)}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
