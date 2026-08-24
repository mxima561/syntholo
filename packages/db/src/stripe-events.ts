import { isOfferId } from "@syntholo/domain/offers";
import { fulfillCheckout, revokeSubscription } from "./purchases";

export async function handleCheckoutCompleted(object: Record<string, unknown>) {
  const sessionId = typeof object.id === "string" ? object.id : null;
  const offer =
    object.metadata && typeof (object.metadata as Record<string, unknown>).offer === "string"
      ? ((object.metadata as Record<string, unknown>).offer as string)
      : null;
  const email =
    object.customer_details && typeof (object.customer_details as Record<string, unknown>).email === "string"
      ? ((object.customer_details as Record<string, unknown>).email as string)
      : null;
  if (!sessionId || !offer || !isOfferId(offer) || !email) return;

  await fulfillCheckout({
    sessionId,
    email,
    offer,
    kind: object.mode === "subscription" ? "subscription" : "payment",
    customerId: typeof object.customer === "string" ? object.customer : null,
    subscriptionId: typeof object.subscription === "string" ? object.subscription : null,
    userId:
      typeof object.client_reference_id === "string" && object.client_reference_id
        ? object.client_reference_id
        : null,
  });
}

export async function handleSubscriptionCanceled(object: Record<string, unknown>) {
  const subscriptionId = typeof object.id === "string" ? object.id : null;
  if (!subscriptionId) return;
  await revokeSubscription({ subscriptionId });
}

export async function dispatchStripeEvent(event: { id: string; type: string; data?: { object?: unknown } }) {
  const object = (event.data?.object ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(object);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionCanceled(object);
      break;
    case "customer.subscription.updated":
      if ((object as { status?: string }).status === "canceled") {
        await handleSubscriptionCanceled(object);
      }
      break;
    default:
      break;
  }
}
