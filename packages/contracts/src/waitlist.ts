import { z } from "zod";

const EmailSchema = z.string().trim().toLowerCase().min(3).max(254)
  .regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/u)
  .refine((value) => !value.includes(".."), "consecutive dots");

export const WaitlistSourceSchema = z.literal("school");
export type WaitlistSource = z.infer<typeof WaitlistSourceSchema>;

export const WaitlistSubscribeRequestSchema = z.object({
  email: z.string().min(1).max(254),
  source: WaitlistSourceSchema.optional(),
}).strict();
export type WaitlistSubscribeRequest = z.infer<typeof WaitlistSubscribeRequestSchema>;

export const WaitlistSubscribeResponseSchema = z.object({
  status: z.enum(["subscribed", "already-subscribed"]),
  email: EmailSchema,
  createdAt: z.string().datetime({ offset: false, precision: 3 }),
  source: WaitlistSourceSchema,
}).strict();
export type WaitlistSubscribeResponse = z.infer<typeof WaitlistSubscribeResponseSchema>;

export const WaitlistRecordSchema = z.object({
  email: EmailSchema,
  createdAt: z.string().datetime({ offset: false, precision: 3 }),
  source: WaitlistSourceSchema,
}).strict();
export type WaitlistRecord = z.infer<typeof WaitlistRecordSchema>;

export function normalizeWaitlistEmail(value: string): string | null {
  const parsed = EmailSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
