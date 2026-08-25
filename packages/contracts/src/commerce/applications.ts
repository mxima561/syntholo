import { z } from "zod";
import { AttributionInputSchema } from "./attribution";

export const APPLICATION_STATUSES = [
  "submitted",
  "needs_information",
  "approved",
  "declined",
  "checkout_sent",
  "purchased",
] as const;

export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const PilotApplicationInputSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  email: z.email(),
  businessName: z.string().trim().min(1).max(160),
  country: z.string().trim().min(1).max(80),
  goals: z.string().trim().min(1).max(5_000),
  marketingConsent: z.boolean(),
  attribution: AttributionInputSchema.optional(),
});

export type PilotApplicationInput = z.infer<typeof PilotApplicationInputSchema>;
