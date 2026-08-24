export type OfferId = "self-paced" | "operator-club" | "business-os";

export type Offer = {
  id: OfferId;
  name: string;
  kind: "payment" | "subscription";
  /** Amount in cents charged by Stripe. */
  amount: number;
  currency: "usd";
  interval?: "month";
  displayAmount: string;
  support: string;
  note: string;
  /** Course granted on successful payment. Null for software-only offers. */
  grantsCourseId: string | null;
};

export const offers: Record<OfferId, Offer> = {
  "self-paced": {
    id: "self-paced",
    name: "AI Operating System Academy",
    kind: "payment",
    amount: 39_900,
    currency: "usd",
    displayAmount: "$399.00",
    support: "Human support through August 2027",
    note: "Unconditional seven-day refund period",
    grantsCourseId: "ai-operating-system-academy",
  },
  "operator-club": {
    id: "operator-club",
    name: "Operator Club",
    kind: "subscription",
    amount: 5_900,
    currency: "usd",
    interval: "month",
    displayAmount: "$59.00 / month",
    support: "Active while subscribed",
    note: "Cancel at the end of any billing period",
    grantsCourseId: "ai-operating-system-academy",
  },
  "business-os": {
    id: "business-os",
    name: "Syntholo Business OS",
    kind: "payment",
    amount: 99_900,
    currency: "usd",
    displayAmount: "$999.00 today",
    support: "$199.00 / month after setup (invoiced separately)",
    note: "Usage-based messaging, phone, and AI charges are separate",
    grantsCourseId: null,
  },
};

export function isOfferId(value: string): value is OfferId {
  return value in offers;
}
