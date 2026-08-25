import { z } from "zod";

export const REQUIRED_ACADEMY_LESSONS = 18;

export const ContentLaunchReadinessSchema = z
  .object({
    requiredLessons: z.literal(REQUIRED_ACADEMY_LESSONS),
    readyLessons: z.number().int().min(0),
    contentHash: z.string().min(1),
    automatedPassedAt: z.string().nullable(),
    humanApprovedAt: z.string().nullable(),
    canSellAcademy: z.boolean(),
  })
  .refine(
    (value) => value.canSellAcademy === Boolean(value.automatedPassedAt && value.humanApprovedAt),
    { message: "canSellAcademy requires automatedPassedAt and humanApprovedAt" },
  );

export type ContentLaunchReadiness = z.infer<typeof ContentLaunchReadinessSchema>;
