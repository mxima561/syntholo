import { z } from "zod";

export const OfferCodeSchema = z.enum([
  "scorecard",
  "guided_pilot",
  "self_paced",
  "operator_club_monthly",
  "operator_club_annual",
  "business_os",
]);

export type OfferCode = z.infer<typeof OfferCodeSchema>;

export const OfferStateSchema = z.enum(["draft", "waitlist", "enabled", "paused"]);
export type OfferState = z.infer<typeof OfferStateSchema>;

export const OfferAvailabilitySchema = z.object({
  available: z.boolean(),
  reasonCode: z.string().nullable(),
  startsAt: z.string().datetime().nullable(),
});

export type OfferAvailability = z.infer<typeof OfferAvailabilitySchema>;

export const PublicOfferSchema = z.object({
  code: OfferCodeSchema,
  slug: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["lead", "payment", "subscription"]),
  state: OfferStateSchema,
  displayAmount: z.string().nullable(),
  available: z.boolean(),
  reasonCode: z.string().nullable(),
  startsAt: z.string().datetime().nullable(),
});

export type PublicOffer = z.infer<typeof PublicOfferSchema>;

export const CreateCheckoutInputSchema = z.object({
  offerCode: OfferCodeSchema,
  email: z.email(),
  authorizationToken: z.string().min(1).optional(),
});

export type CreateCheckoutInput = z.infer<typeof CreateCheckoutInputSchema>;
