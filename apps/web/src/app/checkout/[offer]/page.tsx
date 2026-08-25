import { ArrowLeft, ArrowRight, Check, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getCurrentAccount } from "@/lib/server/accounts";
import { getRuntimeEnv } from "@/lib/config/env";
import { checkoutErrorCopy } from "@syntholo/domain";
import { isOfferId, offers } from "@/lib/domain/offers";
import { resolveCheckoutOffer } from "@/lib/commerce/checkout-state";
import { loadCheckoutContext } from "@/lib/server/checkout";
import { startCheckoutAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ offer: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ offer }, { error }] = await Promise.all([params, searchParams]);
  if (!isOfferId(offer)) notFound();
  const selected = offers[offer];
  const account = await getCurrentAccount();
  const stripeReady = Boolean(getRuntimeEnv().stripe);
  const resolved = resolveCheckoutOffer(offer, await loadCheckoutContext(account), process.env);
  if (!resolved) notFound();

  const gateMessage = !resolved.allowed ? resolved.message : null;
  const queryMessage =
    error === "email"
      ? "Enter a valid email so we can deliver your access."
      : error === "stripe"
        ? "Stripe could not start this checkout. Please try again."
        : error
          ? checkoutErrorCopy(error)
          : null;
  const canPay = resolved.allowed;

  return (
    <main className="checkout-page">
      <div className="checkout-shell">
        <Link className="text-link" href="/pricing"><ArrowLeft aria-hidden size={15} /> Change plan</Link>
        <div className="checkout-layout">
          <section className="checkout-copy">
            <Link className="brand" href="/"><span className="brand-mark">S</span><span>Syntholo</span></Link>
            <span className="micro-label">{stripeReady ? "SECURE CHECKOUT" : "SECURE CHECKOUT PREVIEW"}</span>
            <h1>{selected.name}</h1>
            <p>One business workspace for an owner and two teammates.</p>
            <ul>
              <li><Check aria-hidden size={15} />{selected.support}</li>
              <li><Check aria-hidden size={15} />{selected.note}</li>
              <li><Check aria-hidden size={15} />Course purchase remains useful without optional software</li>
            </ul>
          </section>
          <form action={startCheckoutAction} className="checkout-card">
            <input name="offer" type="hidden" value={offer} />
            <div className="order-line"><span>{selected.name}</span><strong>{selected.displayAmount}</strong></div>
            {selected.kind === "subscription" ? (
              <div className="checkout-disclosure">This offer includes recurring billing. The renewal amount and date are confirmed before the live payment is submitted.</div>
            ) : null}
            {gateMessage ? <p className="checkout-error">{gateMessage}</p> : null}
            {queryMessage && queryMessage !== gateMessage ? <p className="checkout-error">{queryMessage}</p> : null}
            {canPay ? (
              <>
                {account ? (
                  <label>Paying as<input disabled value={account.email} /></label>
                ) : (
                  <label>Work email<input name="email" placeholder="you@company.com" required type="email" /></label>
                )}
                <label className="consent-row"><input required type="checkbox" /> I agree to Syntholo’s terms and refund policy.</label>
                <Button formAction={startCheckoutAction} size="large" type="submit">
                  Continue to secure payment <ArrowRight aria-hidden size={16} />
                </Button>
              </>
            ) : (
              <Button href="/pricing" size="large" type="button">
                Back to pricing <ArrowRight aria-hidden size={16} />
              </Button>
            )}
            <p className="privacy-note">
              <LockKeyhole aria-hidden size={13} />
              {canPay
                ? stripeReady
                  ? "Payments are processed by Stripe. Card details never touch our servers."
                  : "Stripe test keys are not configured yet, so no payment page opens."
                : "Checkout stays closed until this offer is authorized on the server."}
            </p>
          </form>
        </div>
      </div>
    </main>
  );
}
