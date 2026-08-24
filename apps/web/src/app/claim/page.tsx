import { ArrowRight, CheckCircle2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ClaimPage() {
  return (
    <main className="claim-page">
      <section className="claim-card">
        <span className="success-icon"><CheckCircle2 aria-hidden size={25} /></span>
        <span className="micro-label">DEMO PURCHASE CONFIRMED</span>
        <h1>Your Syntholo workspace is ready to claim.</h1>
        <p>Use the same verified email from checkout. In production, WorkOS offers a passwordless code, Google, or Microsoft.</p>
        <div className="claim-email"><Mail aria-hidden size={17} /><span><small>Claim link sent to</small><strong>maria@northstar.example</strong></span></div>
        <Button href="/learn" size="large">Claim this demo workspace <ArrowRight aria-hidden size={16} /></Button>
        <p className="privacy-note">Claim links are single-use and expire after seven days.</p>
      </section>
    </main>
  );
}
