import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getRuntimeEnv } from "@/lib/config/env";
import { isOfferId, offers } from "@/lib/domain/offers";
import { getStripeClient } from "@/lib/integrations/stripe";
import { getCurrentAccount } from "@/lib/server/accounts";
import { fulfillCheckout } from "@/lib/server/purchases";

export const dynamic = "force-dynamic";

type ClaimState = {
  mode: "paid" | "demo" | "pending" | "error" | "mismatch";
  offerName: string;
  detail?: string;
  checkoutEmail?: string;
};

async function resolveClaim(sessionId: string | undefined, legacyOffer: string | undefined): Promise<ClaimState> {
  if (!sessionId) {
    const demoOffer = legacyOffer && isOfferId(legacyOffer) ? offers[legacyOffer] : null;
    return { mode: "demo", offerName: demoOffer?.name ?? "Syntholo Academy" };
  }

  if (!getRuntimeEnv().stripe) {
    return { mode: "error", offerName: "Your order", detail: "Stripe is not configured on this deployment yet." };
  }

  try {
    const session = await getStripeClient().checkout.sessions.retrieve(sessionId);
    const paid = session.status === "complete" && (session.payment_status === "paid" || session.payment_status === "no_payment_required");
    if (!paid) {
      return { mode: "pending", offerName: "Your order", detail: "We have not received a completed payment for this session." };
    }

    const offerId = session.metadata?.offer ?? "";
    if (!isOfferId(offerId)) {
      return { mode: "error", offerName: "Your order", detail: "This checkout session does not reference a known offer." };
    }
    const email = session.customer_details?.email ?? "";
    if (!email) {
      return { mode: "error", offerName: offers[offerId].name, detail: "The checkout session has no customer email to deliver access to." };
    }

    await fulfillCheckout({
      sessionId: session.id,
      email,
      offer: offerId,
      kind: session.mode === "subscription" ? "subscription" : "payment",
      customerId: typeof session.customer === "string" ? session.customer : null,
      subscriptionId: typeof session.subscription === "string" ? session.subscription : null,
      userId: session.client_reference_id,
    });

    return { mode: "paid", offerName: offers[offerId].name, checkoutEmail: email.toLowerCase() };
  } catch {
    return { mode: "error", offerName: "Your order", detail: "We could not verify this checkout session with Stripe." };
  }
}

export default async function ClaimPage({ searchParams }: { searchParams: Promise<{ session_id?: string; offer?: string }> }) {
  const { session_id, offer } = await searchParams;
  const state = await resolveClaim(session_id, offer);
  const account = await getCurrentAccount();
  const mismatch = state.mode === "paid" && account && state.checkoutEmail && account.email !== state.checkoutEmail;
  const href = mismatch ? "/signin" : state.mode === "paid" || state.mode === "demo" ? (account ? "/learn" : "/signin") : "/pricing";
  const cta = mismatch ? "Use the checkout email" : state.mode === "paid" ? (account ? "Open your academy" : "Sign in to claim") : "Continue";

  return (
    <main className="claim-page">
      <section className="claim-card">
        <span className="success-icon"><CheckCircle2 aria-hidden size={25} /></span>
        <span className="micro-label">
          {state.mode === "paid" ? "PAYMENT CONFIRMED" : state.mode === "demo" ? "DEMO PURCHASE CONFIRMED" : state.mode === "pending" ? "PAYMENT PENDING" : "CHECKOUT ISSUE"}
        </span>
        <h1>
          {state.mode === "paid"
            ? `${state.offerName} access is active.`
            : state.mode === "demo"
              ? "Demo purchase confirmed."
              : state.mode === "pending"
                ? "Payment not finished yet."
                : "We could not confirm this payment."}
        </h1>
        <p>
          {mismatch
            ? `This purchase belongs to ${state.checkoutEmail}. Sign in with that Clerk email — do not attach it to a different account.`
            : state.mode === "paid"
            ? "Sign in with the email you used at checkout and your course will be waiting in your workspace."
            : state.detail ?? "Use the same verified email from checkout when you sign in."}
        </p>
        <Button href={href} size="large">
          {cta} <ArrowRight aria-hidden size={16} />
        </Button>
        {state.mode === "demo" ? <p className="privacy-note">Preview mode: no charge was made. Configure Stripe test keys to enable real checkout.</p> : null}
      </section>
    </main>
  );
}
