import Stripe from "stripe";
import { getRuntimeEnv } from "@/lib/config/env";

let client: Stripe | undefined;

export function getStripeClient() {
  const config = getRuntimeEnv().stripe;
  if (!config) throw new Error("Stripe is not configured. Demo checkout is active.");
  client ??= new Stripe(config.secretKey);
  return client;
}
