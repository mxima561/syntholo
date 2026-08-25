import { createStaffAction, setStaffRoleAction, setStaffStatusAction } from "@/app/actions";
import { requireStaff } from "@/lib/auth/staff";
import { listStaff } from "@syntholo/db";
import { CopyId } from "@/components/copy-id";

export const dynamic = "force-dynamic";

export default async function StaffPage() {
  await requireStaff("staff");
  const rows = await listStaff();

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Internal access</span>
          <h1>Staff</h1>
          <p>Cloudflare Access only decides who can reach this origin. Neon Auth identifies the person. Only rows here can use the admin console. There is no auto-provisioning from Access or from school membership.</p>
        </div>
      </section>

      <section className="content-editor-panel">
        <form action={createStaffAction} className="stage-editor-form">
          <label>Email<input name="email" required type="email" /></label>
          <label>
            Role
            <select defaultValue="support" name="role">
              <option value="super_admin">super_admin</option>
              <option value="admin">admin</option>
              <option value="support">support</option>
              <option value="finance">finance</option>
            </select>
          </label>
          <button className="button button-primary button-small" type="submit">Add staff</button>
        </form>
      </section>

      <section className="admin-table">
        <header><span>Email</span><span>Role</span><span>Status</span><span>Last seen</span><span /></header>
        {rows.map((member) => (
          <div className="student-row" key={member.id}>
            <div>
              <strong>{member.email}</strong>
              <CopyId value={member.publicId} />
            </div>
            <form action={setStaffRoleAction}>
              <input name="staffId" type="hidden" value={member.id} />
              <select defaultValue={member.role} name="role">
                <option value="super_admin">super_admin</option>
                <option value="admin">admin</option>
                <option value="support">support</option>
                <option value="finance">finance</option>
              </select>
              <button className="button button-secondary button-small" type="submit">Save role</button>
            </form>
            <i className={`status-pill ${member.status === "active" ? "live" : ""}`}>{member.status}</i>
            <span>{member.lastSeenAt ? member.lastSeenAt.toLocaleDateString("en-US") : "—"}</span>
            <form action={setStaffStatusAction}>
              <input name="staffId" type="hidden" value={member.id} />
              <input name="status" type="hidden" value={member.status === "active" ? "suspended" : "active"} />
              <button className="button button-secondary button-small" type="submit">
                {member.status === "active" ? "Suspend" : "Reactivate"}
              </button>
            </form>
          </div>
        ))}
      </section>
    </div>
  );
}
