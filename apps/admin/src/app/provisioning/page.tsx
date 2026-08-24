import { Check, Clock3, ShieldCheck } from "lucide-react";
import { saveProvisioningNoteAction, toggleLaunchCheckAction } from "@/app/actions";
import { requireStaff } from "@/lib/auth/staff";
import { DEFAULT_SOFTWARE_CHECKS, listSoftwareAccounts } from "@syntholo/db";
import { CopyId } from "@/components/copy-id";

export const dynamic = "force-dynamic";

export default async function AdminProvisioningPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  await requireStaff();
  const { id } = await searchParams;
  const accounts = await listSoftwareAccounts();
  const selected = accounts.find((account) => account.id === id) ?? accounts[0] ?? null;

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Business OS operations</span>
          <h1>Provisioning queue</h1>
          <p>Real student questionnaires. Tick launch checks to activate. Notes are stored on the software account.</p>
        </div>
      </section>
      {accounts.length === 0 ? (
        <p className="empty-note">No Business OS accounts yet. They appear when a student opens Business OS.</p>
      ) : (
        <section className="provisioning-queue">
          <aside>
            <div><span className="micro-label">Accounts</span><strong>{accounts.length}</strong></div>
            {accounts.map((account) => (
              <a className={selected?.id === account.id ? "active" : undefined} href={`/provisioning?id=${account.id}`} key={account.id}>
                <span className={`queue-state ${account.status === "provisioning" ? "healthy" : account.status}`} />
                <div>
                  <strong>{account.studentName || account.studentEmail}</strong>
                  <small>{account.studentPublicId} · {account.status.replaceAll("_", " ")}</small>
                </div>
              </a>
            ))}
          </aside>
          {selected ? (
            <section className="provisioning-detail">
              <header>
                <div>
                  <span className="micro-label">Customer setup</span>
                  <h2>{selected.studentName || selected.studentEmail}</h2>
                  <p>
                    <CopyId value={selected.studentPublicId ?? selected.userId} />
                    {selected.provisioningDueAt ? ` · due ${selected.provisioningDueAt.toLocaleDateString("en-US")}` : ""}
                  </p>
                </div>
                <span className={`status-pill ${selected.status}`}>{selected.status.replaceAll("_", " ")}</span>
              </header>
              <div className="activation-list">
                <div>
                  <span className="micro-label">Student questionnaire</span>
                  <strong>{selected.checklist.filter((item) => item.complete).length} of {selected.checklist.length} complete</strong>
                </div>
                {selected.checklist.map((item, index) => (
                  <div className="activation-row" key={item.id}>
                    <span className={`activation-chip ${item.complete ? "done" : ""}`}>{item.complete ? <Check size={13} /> : String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.complete ? "Student marked complete" : "Waiting on student"}</small>
                    </div>
                  </div>
                ))}
              </div>
              <div className="activation-list">
                <div>
                  <span className="micro-label">Activation standard</span>
                  <strong>{selected.checks.length} of {DEFAULT_SOFTWARE_CHECKS.length} checks passed</strong>
                </div>
                {DEFAULT_SOFTWARE_CHECKS.map((check, index) => {
                  const done = selected.checks.includes(check);
                  return (
                    <form action={toggleLaunchCheckAction} key={check}>
                      <input name="accountId" type="hidden" value={selected.id} />
                      <input name="check" type="hidden" value={check} />
                      <button className="launch-check" type="submit">
                        <span className={`activation-chip ${done ? "done" : ""}`}>{done ? <Check size={13} /> : String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <strong>{check}</strong>
                          <small>{done ? "Verified" : "Required before activation"}</small>
                        </div>
                        {done ? <ShieldCheck size={14} /> : <Clock3 size={14} />}
                      </button>
                    </form>
                  );
                })}
              </div>
            </section>
          ) : null}
          {selected ? (
            <aside className="provisioning-notes">
              <span className="micro-label">Internal notes</span>
              {selected.notes ? <article><p>{selected.notes}</p></article> : <p className="empty-note">No notes yet.</p>}
              <form action={saveProvisioningNoteAction}>
                <input name="accountId" type="hidden" value={selected.id} />
                <label>Add an internal note<textarea name="note" placeholder="Visible only to admins and operators" required /></label>
                <button className="button button-secondary button-small" type="submit">Save note</button>
              </form>
            </aside>
          ) : null}
        </section>
      )}
    </div>
  );
}
