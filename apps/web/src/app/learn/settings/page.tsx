import { Button } from "@/components/ui/button";
import { requireStudentAccount } from "@/lib/server/accounts";
import { getPrimaryCourse } from "@/lib/server/courses";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const account = await requireStudentAccount();
  const course = await getPrimaryCourse();
  const displayName = `${account.firstName} ${account.lastName}`.trim() || account.email.split("@")[0];

  return (
    <div className="member-page simple-page">
      <span className="eyebrow"><span className="eyebrow-dot" /> Workspace</span>
      <h1>Settings</h1>
      <div className="settings-grid">
        <section>
          <span className="micro-label">Profile</span>
          <h2>{displayName}</h2>
          <p>{account.email}</p>
          <Button size="small" variant="secondary">Edit profile</Button>
        </section>
        <section>
          <span className="micro-label">Access</span>
          <h2>Academy access</h2>
          <p>Enrolled in {course?.title ?? "the academy"}. Lifetime course access.</p>
        </section>
      </div>
    </div>
  );
}
