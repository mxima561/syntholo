import { refundPurchaseAction } from "@/app/actions";
import { requireStaff } from "@/lib/auth/staff";
import { listPaidPurchases } from "@syntholo/db";

export const dynamic = "force-dynamic";

export default async function CommercePage() {
  await requireStaff("billing");
  const purchases = await listPaidPurchases(100);

  return (
    <div className="admin-page">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Revenue operations</span>
          <h1>Commerce</h1>
          <p>Refunds update the purchase, drop enrollments granted by it, and write one audit row.</p>
        </div>
      </section>
      <section className="admin-table">
        <header><span>Email</span><span>Offer</span><span>Kind</span><span>Status</span><span /></header>
        {purchases.length === 0 ? <p className="empty-note">No purchases yet.</p> : purchases.map((purchase) => (
          <div className="student-row" key={purchase.id}>
            <strong>{purchase.email}</strong>
            <span>{purchase.offer}</span>
            <span>{purchase.kind}</span>
            <i className={`status-pill ${purchase.status === "paid" ? "live" : ""}`}>{purchase.status}</i>
            {purchase.status === "paid" ? (
              <form action={refundPurchaseAction}>
                <input name="purchaseId" type="hidden" value={purchase.id} />
                <button className="button button-secondary button-small" type="submit">Refund</button>
              </form>
            ) : <span />}
          </div>
        ))}
      </section>
    </div>
  );
}
