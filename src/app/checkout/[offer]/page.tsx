import { ArrowLeft, ArrowRight, Check, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";

const offers = {
  "self-paced": { name: "AI Operating System Academy", amount: "$399.00", recurring: false, support: "Human support through August 2027", note: "Unconditional seven-day refund period" },
  "operator-club": { name: "Operator Club", amount: "$59.00 / month", recurring: true, support: "Active while subscribed", note: "Cancel at the end of any billing period" },
  "business-os": { name: "Syntholo Business OS", amount: "$999.00 today", recurring: true, support: "$199.00 / month after setup", note: "Usage-based messaging, phone, and AI charges are separate" },
} as const;

export default async function CheckoutPage({ params }: { params: Promise<{ offer: string }> }) {
  const { offer } = await params;
  const selected = offers[offer as keyof typeof offers];
  if (!selected) notFound();

  return (
    <main className="checkout-page">
      <div className="checkout-shell">
        <Link className="text-link" href="/pricing"><ArrowLeft aria-hidden size={15} /> Change plan</Link>
        <div className="checkout-layout">
          <section className="checkout-copy">
            <Link className="brand" href="/"><span className="brand-mark">S</span><span>Syntholo</span></Link>
            <span className="micro-label">SECURE CHECKOUT PREVIEW</span>
            <h1>{selected.name}</h1>
            <p>One business workspace for an owner and two teammates.</p>
            <ul><li><Check aria-hidden size={15} />{selected.support}</li><li><Check aria-hidden size={15} />{selected.note}</li><li><Check aria-hidden size={15} />Course purchase remains useful without optional software</li></ul>
          </section>
          <section className="checkout-card">
            <div className="order-line"><span>{selected.name}</span><strong>{selected.amount}</strong></div>
            {selected.recurring ? <div className="checkout-disclosure">This offer includes recurring billing. The renewal amount and date are confirmed before the live payment is submitted.</div> : null}
            <label>Work email<input defaultValue="maria@northstar.example" type="email" /></label>
            <label>Card information<div className="fake-card-field"><span>4242 4242 4242 4242</span><span>12/30 &nbsp; 123</span></div></label>
            <label className="consent-row"><input type="checkbox" /> I agree to Syntholo’s terms and refund policy.</label>
            <Button href={`/claim?offer=${offer}`} size="large">Complete demo purchase <ArrowRight aria-hidden size={16} /></Button>
            <p className="privacy-note"><LockKeyhole aria-hidden size={13} /> Demo mode: no charge is made. Stripe activates when production credentials are configured.</p>
          </section>
        </div>
      </div>
    </main>
  );
}

