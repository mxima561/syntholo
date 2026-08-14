import { z } from "zod";

const CAPABILITIES = [
  "academy_course",
  "support",
  "circle_write",
  "operator_club",
  "business_os",
] as const;
const HOLD_KINDS = [
  "commerce",
  "seat_changes",
  "business_os_activation",
] as const;

const UuidSchema = z.string().uuid();
const CapabilitySchema = z.enum(CAPABILITIES);
const HoldKindSchema = z.enum(HOLD_KINDS);

function isCanonicalSequence<T extends string>(
  values: readonly T[],
  canonical: readonly T[],
): boolean {
  const positions = new Map(canonical.map((value, index) => [value, index]));
  return values.every((value, index) =>
    index === 0
    || (positions.get(values[index - 1]!) ?? -1) < (positions.get(value) ?? -1));
}

export const MemberAccessQuerySchema = z.object({}).strict();

const ExplanationSchema = z.object({
  capability: CapabilitySchema,
  sourceGrantIds: z.array(UuidSchema).superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length
      || ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
      context.addIssue({ code: "custom", message: "Source IDs must be unique and sorted" });
    }
  }),
}).strict();

export const MemberAccessResponseSchema = z.object({
  accountId: UuidSchema,
  capabilities: z.object({
    academy_course: z.boolean(),
    support: z.boolean(),
    circle_write: z.boolean(),
    operator_club: z.boolean(),
    business_os: z.boolean(),
  }).strict(),
  holds: z.array(HoldKindSchema).max(HOLD_KINDS.length).superRefine(
    (holds, context) => {
      if (!isCanonicalSequence(holds, HOLD_KINDS)) {
        context.addIssue({ code: "custom", message: "Holds must be unique and canonical" });
      }
    },
  ),
  seatLimit: z.literal(3),
  reservedSeats: z.number().int().min(0).max(3),
  explanations: z.array(ExplanationSchema).length(CAPABILITIES.length)
    .superRefine((explanations, context) => {
      if (explanations.some((value, index) => value.capability !== CAPABILITIES[index])) {
        context.addIssue({ code: "custom", message: "Explanations must be canonical" });
      }
    }),
}).strict().superRefine((access, context) => {
  const seenGrantIds = new Set<string>();
  for (const explanation of access.explanations) {
    if (access.capabilities[explanation.capability]
      !== (explanation.sourceGrantIds.length > 0)) {
      context.addIssue({
        code: "custom",
        message: "Capability and explanation disagree",
      });
    }
    for (const sourceGrantId of explanation.sourceGrantIds) {
      if (seenGrantIds.has(sourceGrantId)) {
        context.addIssue({
          code: "custom",
          message: "A grant cannot explain multiple capabilities",
        });
      }
      seenGrantIds.add(sourceGrantId);
    }
  }
});

export type MemberAccessResponse = z.infer<typeof MemberAccessResponseSchema>;
