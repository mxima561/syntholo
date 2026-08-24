"use server";

import { saveScorecard } from "@syntholo/db";

export async function submitScorecardAction(input: {
  firstName: string;
  email: string;
  businessName: string;
  country: string;
  overallScore: number;
  band: string;
  answers: Record<string, number>;
  marketingConsent: boolean;
}) {
  if (!input.firstName.trim() || !input.email.trim() || !input.businessName.trim() || !input.country.trim()) {
    return { ok: false as const };
  }
  await saveScorecard({
    email: input.email.trim(),
    firstName: input.firstName.trim(),
    businessName: input.businessName.trim(),
    country: input.country.trim(),
    overallScore: input.overallScore,
    band: input.band,
    answers: input.answers,
    marketingConsent: input.marketingConsent,
  });
  return { ok: true as const };
}
