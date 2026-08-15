import { z } from "zod";
import { MemberAccessResponseSchema } from "@syntholo/contracts/entitlements";

const UuidSchema = z.string().uuid();

export function forbiddenAccountNameCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || [0xa0, 0xad, 0x61c, 0x1680, 0x180e, 0x3000, 0xfeff]
      .includes(codePoint)
    || (codePoint >= 0x2000 && codePoint <= 0x200f)
    || (codePoint >= 0x2028 && codePoint <= 0x202f)
    || (codePoint >= 0x205f && codePoint <= 0x206f)
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    || (codePoint >= 0xfdd0 && codePoint <= 0xfdef)
    || (codePoint & 0xffff) === 0xfffe
    || (codePoint & 0xffff) === 0xffff;
}

export function canonicalizeAccountName(input: string): string {
  const value = input.normalize("NFC").replace(/^ +| +$/gu, "");
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (
    byteLength < 1
    || byteLength > 255
    || [...value].some((scalar) =>
      forbiddenAccountNameCodePoint(scalar.codePointAt(0)!))
  ) {
    throw new Error("ACCOUNT_NAME_INVALID");
  }
  return value;
}

export function isCanonicalAccountName(value: string): boolean {
  try {
    return canonicalizeAccountName(value) === value;
  } catch {
    return false;
  }
}

export const UtcMillisecondInstantSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const instant = new Date(value);
    return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
  });

export const AccountNameSchema = z.string().superRefine((value, context) => {
  if (!isCanonicalAccountName(value)) {
    context.addIssue({ code: "custom", message: "Invalid account name" });
  }
});

const ProjectionUnavailableReasonSchema = z.enum([
  "module_not_implemented",
  "dependency_unavailable",
]);

const UnavailableProjectionSchema = z.object({
  state: z.literal("unavailable"),
  reason: ProjectionUnavailableReasonSchema,
}).strict();

const LearningProjectionSchema = z.discriminatedUnion("state", [
  UnavailableProjectionSchema,
  z.object({
    state: z.literal("empty"),
    reason: z.enum(["no_enrollment", "no_required_lesson"]),
  }).strict(),
]);

function projectionSchema<TReason extends string>(reason: TReason) {
  return z.discriminatedUnion("state", [
    UnavailableProjectionSchema,
    z.object({ state: z.literal("empty"), reason: z.literal(reason) }).strict(),
  ]);
}

export const MemberDashboardQuerySchema = z.object({}).strict();

export const MemberDashboardProjectionsSchema = z.object({
  learning: LearningProjectionSchema,
  support: projectionSchema("no_customer_response_due"),
  sessions: projectionSchema("no_session_within_48_hours"),
  implementation: projectionSchema("no_incomplete_artifact_or_feedback"),
  recommendations: projectionSchema("no_optional_recommendation"),
}).strict();

export const MemberDashboardNextBestStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("access_blocker"),
    reason: z.literal("academy_course_required"),
    target: z.literal("program_options"),
  }).strict(),
  z.object({
    kind: z.literal("enrollment_blocker"),
    reason: z.literal("academy_enrollment_missing"),
    target: z.literal("retry"),
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    blockedBy: z.enum([
      "support",
      "sessions",
      "learning",
      "implementation",
      "recommendations",
    ]),
    reason: ProjectionUnavailableReasonSchema,
    target: z.literal("retry"),
  }).strict(),
  z.object({
    kind: z.literal("none"),
    reason: z.literal("no_action_available"),
    target: z.null(),
  }).strict(),
]);

type DashboardProjections = z.infer<typeof MemberDashboardProjectionsSchema>;
type UnavailableProjectionName = "support" | "sessions" | "learning"
  | "implementation" | "recommendations";

function firstUnavailableProjection(projections: DashboardProjections): Readonly<{
  blockedBy: UnavailableProjectionName;
  reason: z.infer<typeof ProjectionUnavailableReasonSchema>;
}> | null {
  const order: readonly UnavailableProjectionName[] = [
    "support",
    "sessions",
    "learning",
    "implementation",
    "recommendations",
  ];
  for (const blockedBy of order) {
    const projection = projections[blockedBy];
    if (projection.state === "unavailable") {
      return { blockedBy, reason: projection.reason };
    }
  }
  return null;
}

export const MemberDashboardResponseSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: UtcMillisecondInstantSchema,
  account: z.object({ id: UuidSchema, name: AccountNameSchema }).strict(),
  access: MemberAccessResponseSchema,
  experience: z.object({
    state: z.enum(["access_required", "no_enrollment", "partial", "ready"]),
  }).strict(),
  projections: MemberDashboardProjectionsSchema,
  nextBestStep: MemberDashboardNextBestStepSchema,
}).strict().superRefine((value, context) => {
  const academyMissing = !value.access.capabilities.academy_course;
  const enrollmentMissing = !academyMissing
    && value.projections.learning.state === "empty"
    && value.projections.learning.reason === "no_enrollment";
  const firstUnavailable = !academyMissing && !enrollmentMissing
    ? firstUnavailableProjection(value.projections)
    : null;
  const partial = !academyMissing && !enrollmentMissing
    && firstUnavailable !== null;
  const ready = !academyMissing && !enrollmentMissing
    && firstUnavailable === null;

  const invalid = (message: string) =>
    context.addIssue({ code: "custom", message });

  if (value.account.id !== value.access.accountId) invalid("Account IDs disagree");
  if ((value.experience.state === "access_required") !== academyMissing) {
    invalid("Access-required state disagrees with access");
  }
  if ((value.experience.state === "no_enrollment") !== enrollmentMissing) {
    invalid("No-enrollment state disagrees with learning");
  }
  if ((value.experience.state === "partial") !== partial) {
    invalid("Partial state disagrees with projections");
  }
  if ((value.experience.state === "ready") !== ready) {
    invalid("Ready state disagrees with projections");
  }

  const next = value.nextBestStep;
  if ((next.kind === "access_blocker") !== academyMissing) {
    invalid("Access blocker disagrees with experience");
  }
  if ((next.kind === "enrollment_blocker") !== enrollmentMissing) {
    invalid("Enrollment blocker disagrees with experience");
  }
  if ((next.kind === "unavailable") !== partial) {
    invalid("Unavailable step disagrees with experience");
  } else if (
    next.kind === "unavailable"
    && (firstUnavailable === null
      || next.blockedBy !== firstUnavailable.blockedBy
      || next.reason !== firstUnavailable.reason)
  ) {
    invalid("Unavailable step violates projection precedence");
  }
  if ((next.kind === "none") !== ready) {
    invalid("No-action step disagrees with experience");
  }
  if (
    ready
    && (value.projections.learning.state !== "empty"
      || value.projections.learning.reason !== "no_required_lesson")
  ) {
    invalid("Ready requires a proven empty required lesson");
  }
});

export type ProjectionUnavailableReason = z.infer<
  typeof ProjectionUnavailableReasonSchema
>;
export type MemberDashboardProjections = z.infer<
  typeof MemberDashboardProjectionsSchema
>;
export type MemberDashboardNextBestStep = z.infer<
  typeof MemberDashboardNextBestStepSchema
>;
export type MemberDashboardResponse = z.infer<
  typeof MemberDashboardResponseSchema
>;
