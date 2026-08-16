import Link from "next/link";
import { notFound } from "next/navigation";

/**
 * Checkout is intentionally disabled. This page previously rendered a payment
 * mockup with a dead "continue to payment" control. Per the production launch
 * gates, no Academy payment may be enabled until all 18 required lessons are
 * published, and Business OS checkout requires its separate readiness gate.
 */
const offers = {
  "self-paced": "AI Operating System Academy",
  "operator-club": "Operator Club",
  "business-os": "Syntholo Business OS",
} as const;

export default async function CheckoutPage({ params }: { params: Promise<{ offer: string }> }) {
  const { offer } = await params;
  const name = offers[offer as keyof typeof offers];
  if (!name) notFound();

  return (
    <main className="state-page">
      <span className="brand-mark">S</span>
      <span className="micro-label">Checkout</span>
      <h1>{name} is not on sale yet.</h1>
      <p>
        Enrollment opens once the full curriculum is published and the launch
        gates pass. No payment can be taken before then.
      </p>
      <Link className="button button-dark button-medium" href="/pricing">
        Back to program options
      </Link>
    </main>
  );
}
