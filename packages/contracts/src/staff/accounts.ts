import { z } from "zod";

export const StaffAccountSummarySchema = z.object({
  accountId: z.string().uuid(),
  accountName: z.string(),
  status: z.enum(["active", "suspended", "deleted"]),
  ownerEmail: z.string().nullable(),
  enrolledCourseCount: z.number().int().min(0),
}).strict();

export const StaffAccountListResponseSchema = z.object({
  accounts: z.array(StaffAccountSummarySchema),
}).strict();

export type StaffAccountSummary = z.infer<typeof StaffAccountSummarySchema>;
