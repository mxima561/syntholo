import { z } from "zod";

export const ATTRIBUTION_FIELD_MAX = 160;

const TouchSchema = z.object({
  source: z.string().max(ATTRIBUTION_FIELD_MAX).optional(),
  medium: z.string().max(ATTRIBUTION_FIELD_MAX).optional(),
  campaign: z.string().max(ATTRIBUTION_FIELD_MAX).optional(),
  content: z.string().max(ATTRIBUTION_FIELD_MAX).optional(),
  landingPath: z.string().max(ATTRIBUTION_FIELD_MAX).optional(),
});

export const AttributionInputSchema = z
  .object({
    firstTouch: TouchSchema.optional(),
    lastTouch: TouchSchema.optional(),
    consentedAt: z.string().datetime().optional(),
  })
  .strip();

export type AttributionInput = z.infer<typeof AttributionInputSchema>;
