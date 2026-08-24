import { notFound } from "next/navigation";
import Link from "next/link";
import { requireStudentAccount } from "@/lib/server/accounts";
import { getPurchasesForUser } from "@/lib/server/purchases";

export const dynamic = "force-dynamic";

export default async function SettingsSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (section !== "billing") notFound();
  const account = await requireStudentAccount();
  const purchases = await getPurchasesForUser(account.id);

  return (
    <div className="member-page simple-page">
      <span className="eyebrow"><span className="eyebrow-dot" /> Access and billing</span>
      <h1>Your plan</h1>
      <p>Student ID {account.publicId}. Lifetime course access stays with the academy enrollment even if a support window ends.</p>
      <div className="settings-grid">
        {purchases.length === 0 ? (
          <section>
            <span className="micro-label">Academy</span>
            <h2>No paid receipt yet</h2>
            <p>If you were granted access by staff, course access is active without a Stripe receipt.</p>
            <Link className="button button-secondary button-small" href="/pricing">Review options</Link>
          </section>
        ) : purchases.map((purchase) => (
          <section key={purchase.id}>
            <span className="micro-label">{purchase.kind === "subscription" ? "Subscription" : "Purchase"}</span>
            <h2>{purchase.offer}</h2>
            <p>Status: {purchase.status}. Reference {purchase.id}.</p>
          </section>
        ))}
      </div>
    </div>
  );
}
