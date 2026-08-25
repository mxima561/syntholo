"use server";

import { redirect } from "next/navigation";
import type { Route } from "next";
import { getCurrentAccount } from "@/lib/server/accounts";
import { getRuntimeEnv } from "@/lib/config/env";
import { isOfferId, offers } from "@/lib/domain/offers";
import { getStripeClient } from "@/lib/integrations/stripe";
import { resolveCheckoutOffer } from "@/lib/commerce/checkout-state";
import { loadCheckoutContext } from "@/lib/server/checkout";

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function startCheckoutAction(formData: FormData) {
  const offerId = text(formData, "offer");
  if (!isOfferId(offerId)) {
    redirect("/pricing");
  }
  const offer = offers[offerId];
  const account = await getCurrentAccount();
  const email = (account?.email ?? text(formData, "email")).toLowerCase();

  if (!email || !email.includes("@")) {
    redirect(`/checkout/${offerId}?error=email`);
  }

  const resolved = resolveCheckoutOffer(offerId, await loadCheckoutContext(account), process.env);
  if (!resolved) {
    redirect("/pricing");
  }
  if (!resolved.allowed && resolved.reasonCode) {
    redirect(`/checkout/${offerId}?error=${resolved.reasonCode}`);
  }

  if (!getRuntimeEnv().stripe) {
    redirect(`/checkout/${offerId}?error=stripe`);
  }

  const appUrl = getRuntimeEnv().appUrl.replace(/\/$/, "");
  const session = await getStripeClient().checkout.sessions.create({
    mode: offer.kind === "subscription" ? "subscription" : "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: offer.currency,
          unit_amount: offer.amount,
          product_data: { name: offer.name },
          ...(offer.kind === "subscription" ? { recurring: { interval: "month" as const } } : {}),
        },
      },
    ],
    customer_email: email,
    client_reference_id: account?.id,
    metadata: { offer: offer.id, offerCode: resolved.offer.code },
    success_url: `${appUrl}/claim?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/pricing`,
  });

  if (!session.url) {
    redirect(`/checkout/${offerId}?error=stripe`);
  }
  redirect(session.url as Route);
}
