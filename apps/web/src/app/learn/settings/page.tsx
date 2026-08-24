import { requireStudentAccount } from "@/lib/server/accounts";
import { getPrimaryCourse } from "@/lib/server/courses";
import { getCertificate } from "@syntholo/db";
import { getPurchasesForUser } from "@/lib/server/purchases";
import { updateProfileAction } from "@/app/learn/actions";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import type { Route } from "next";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const account = await requireStudentAccount();
  const course = await getPrimaryCourse();
  const [purchases, certificate] = await Promise.all([
    getPurchasesForUser(account.id),
    course ? getCertificate(account.id, course.id) : Promise.resolve(null),
  ]);

  return (
    <div className="member-page simple-page">
      <span className="eyebrow"><span className="eyebrow-dot" /> Workspace</span>
      <h1>Settings</h1>
      <div className="settings-grid">
        <section>
          <span className="micro-label">Student ID</span>
          <h2><code>{account.publicId}</code></h2>
          <p>Use this ID with support or operations. Internal record {account.id}.</p>
        </section>
        <section>
          <span className="micro-label">Access</span>
          <h2>Academy access</h2>
          <p>Enrolled in {course?.title ?? "the academy"}. Lifetime course access.</p>
          {certificate ? <p><Link href={"/learn/certificate" as Route}>Certificate issued {certificate.issuedAt.toLocaleDateString("en-US")}</Link></p> : null}
        </section>
        <section className="settings-span">
          <span className="micro-label">Profile</span>
          <h2>Edit your details</h2>
          <form action={updateProfileAction} className="profile-form">
            <label>First name<input defaultValue={account.firstName} name="firstName" required /></label>
            <label>Last name<input defaultValue={account.lastName} name="lastName" /></label>
            <label>Business name<input defaultValue={account.businessName} name="businessName" /></label>
            <label>Role / title<input defaultValue={account.jobTitle} name="jobTitle" /></label>
            <label>Timezone<input defaultValue={account.timezone} name="timezone" /></label>
            <p>{account.email}</p>
            <Button size="small" type="submit">Save profile</Button>
          </form>
        </section>
        <section>
          <span className="micro-label">Purchases</span>
          <h2>Billing</h2>
          {purchases.length === 0 ? (
            <p>No paid purchases on this account yet. <Link href="/pricing">See academy offers</Link>.</p>
          ) : purchases.map((purchase) => (
            <p key={purchase.id}>{purchase.offer} · {purchase.status} · {purchase.id.slice(0, 8)}</p>
          ))}
          <Button href="/learn/settings/billing" size="small" variant="secondary">Open billing</Button>
        </section>
      </div>
    </div>
  );
}
