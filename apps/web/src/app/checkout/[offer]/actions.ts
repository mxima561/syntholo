"use server";

import { redirect } from "next/navigation";
import type { Route } from "next";
import { getCurrentAccount } from "@/lib/server/accounts";
import { getRuntimeEnv } from "@/lib/config/env";
import { isOfferId, offers } from "@/lib/domain/offers";
import { getStripeClient } from "@/lib/integrations/stripe";

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

  // Demo fallback keeps the preview journey usable before Stripe keys exist.
  if (!getRuntimeEnv().stripe) {
    redirect(`/claim?offer=${offerId}`);
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
    metadata: { offer: offer.id },
    success_url: `${appUrl}/claim?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/pricing`,
  });

  if (!session.url) {
    redirect(`/checkout/${offerId}?error=stripe`);
  }
  // Stripe-hosted checkout lives outside the app's route types.
  redirect(session.url as Route);
}
