import { requireStaff } from "@/lib/auth/staff";
import { listStaff } from "@syntholo/db";
import { CopyId } from "@/components/copy-id";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  await requireStaff();
  const staff = await listStaff();
  const mode = process.env.APP_MODE?.trim() || "demo";
  const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());
  const hasAccess = Boolean(process.env.CF_ACCESS_AUD?.trim());

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Administration</span>
          <h1>Settings</h1>
          <p>Workspace configuration as this process sees it. Staff roles are managed on the Staff page.</p>
        </div>
      </section>
      <section className="admin-metric-grid">
        <article><div><small>APP_MODE</small><strong>{mode}</strong></div></article>
        <article><div><small>Database</small><strong>{hasDatabase ? "connected" : "missing"}</strong></div></article>
        <article><div><small>Cloudflare Access</small><strong>{hasAccess ? "configured" : "dev bypass"}</strong></div></article>
        <article><div><small>Staff rows</small><strong>{staff.length}</strong></div></article>
      </section>
      <section className="admin-table">
        <header><span>Staff ID</span><span>Email</span><span>Role</span><span>Status</span><span /></header>
        {staff.map((member) => (
          <div className="student-row" key={member.id}>
            <CopyId value={member.publicId} />
            <strong>{member.email}</strong>
            <span>{member.role}</span>
            <i className={`status-pill ${member.status === "active" ? "live" : ""}`}>{member.status}</i>
            <span />
          </div>
        ))}
      </section>
    </div>
  );
}
