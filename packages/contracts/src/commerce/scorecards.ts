import { z } from "zod";
import { AttributionInputSchema } from "./attribution";

export const ScorecardLeadInputSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  email: z.email(),
  businessName: z.string().trim().min(1).max(160),
  country: z.string().trim().min(1).max(80),
  overallScore: z.number().int().min(0).max(100),
  band: z.string().trim().min(1).max(40),
  answers: z.record(z.string(), z.number().int().min(0).max(4)),
  marketingConsent: z.boolean(),
  attribution: AttributionInputSchema.optional(),
});

export type ScorecardLeadInput = z.infer<typeof ScorecardLeadInputSchema>;

export const PublicScorecardReportSchema = z.object({
  overallScore: z.number().int().min(0).max(100),
  band: z.string(),
  answers: z.record(z.string(), z.number()),
  expiresAt: z.string().datetime(),
});

export type PublicScorecardReport = z.infer<typeof PublicScorecardReportSchema>;
