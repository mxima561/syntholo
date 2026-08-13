import { z } from "zod";
import type { Actor } from "@syntholo/domain";

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        correlationId: z.string().uuid(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export type RequestContext = Readonly<{
  correlationId: string;
  idempotencyKey?: string;
  actor?: Actor;
}>;
