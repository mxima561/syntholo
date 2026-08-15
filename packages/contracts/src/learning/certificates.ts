import { z } from "zod";
import { isCanonicalAccountName } from "../member-dashboard";
import fontRepertoire from "./certificate-font-repertoire.v1.json";

const utf8 = new TextEncoder();

export const CERTIFICATE_FONT_REPERTOIRE_MANIFEST_SHA256 =
  fontRepertoire.manifestCanonicalSha256;

export function certificateFontSupportsScalar(codePoint: number): boolean {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return false;
  let low = 0;
  let high = fontRepertoire.supportedCodePointRanges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = fontRepertoire.supportedCodePointRanges[middle]!;
    if (codePoint < range[0]!) high = middle - 1;
    else if (codePoint > range[1]!) low = middle + 1;
    else return true;
  }
  return false;
}

function recipientWhitespace(codePoint: number): boolean {
  return (codePoint >= 0x0009 && codePoint <= 0x000d)
    || codePoint === 0x0020
    || codePoint === 0x0085
    || codePoint === 0x00a0
    || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200a)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x202f
    || codePoint === 0x205f
    || codePoint === 0x3000;
}

function invalidRecipientScalar(codePoint: number): boolean {
  return codePoint === 0x7f
    || (codePoint >= 0 && codePoint <= 0x1f)
    || (codePoint >= 0x80 && codePoint <= 0x9f)
    || codePoint === 0x061c
    || codePoint === 0x200e
    || codePoint === 0x200f
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069)
    || (codePoint >= 0xfdd0 && codePoint <= 0xfdef)
    || (codePoint & 0xffff) === 0xfffe
    || (codePoint & 0xffff) === 0xffff;
}

export function canonicalizeCertificateRecipientNameInput(input: string): string {
  for (let index = 0; index < input.length; index += 1) {
    const unit = input.charCodeAt(index);
    if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("CERTIFICATE_RECIPIENT_NAME_INVALID");
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error("CERTIFICATE_RECIPIENT_NAME_INVALID");
      }
      index += 1;
    }
  }
  if (Array.from(input).length > 256 || utf8.encode(input).byteLength > 1_024) {
    throw new Error("CERTIFICATE_RECIPIENT_NAME_INVALID");
  }
  let collapsed = "";
  let whitespaceRun = false;
  for (const scalar of input) {
    if (recipientWhitespace(scalar.codePointAt(0)!)) {
      if (collapsed.length > 0) whitespaceRun = true;
      continue;
    }
    if (whitespaceRun) collapsed += " ";
    collapsed += scalar;
    whitespaceRun = false;
  }
  const canonical = collapsed.normalize("NFC");
  const scalars = Array.from(canonical);
  if (
    scalars.length === 0
    || scalars.length > 120
    || scalars.some((scalar) => invalidRecipientScalar(scalar.codePointAt(0)!))
    || scalars.some((scalar) => !certificateFontSupportsScalar(scalar.codePointAt(0)!))
    || utf8.encode(canonical).byteLength > 480
  ) throw new Error("CERTIFICATE_RECIPIENT_NAME_INVALID");
  return canonical;
}

function isUnicodeScalarText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0 || (unit >= 0xdc00 && unit <= 0xdfff)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    }
  }
  return true;
}

export function certificateBusinessNameSnapshotRenderable(value: string): boolean {
  return isUnicodeScalarText(value)
    && isCanonicalAccountName(value)
    && [...value].every((scalar) => certificateFontSupportsScalar(scalar.codePointAt(0)!));
}

export function certificateCourseTitleSnapshotRenderable(value: string): boolean {
  if (!isUnicodeScalarText(value)) return false;
  const scalars = Array.from(value);
  return scalars.length >= 1
    && scalars.length <= 255
    && value === value.normalize("NFC")
    && utf8.encode(value).byteLength <= 1_020
    && scalars.every((scalar) => !invalidRecipientScalar(scalar.codePointAt(0)!))
    && scalars.every((scalar) => certificateFontSupportsScalar(scalar.codePointAt(0)!));
}

function canonicalText(maxBytes: number) {
  return z.string()
    .refine(isUnicodeScalarText, "Text must contain valid Unicode scalar values")
    .refine((value) => value === value.normalize("NFC"), "Text must use NFC normalization")
    .refine((value) => value === value.trim(), "Text must already be trimmed")
    .refine((value) => utf8.encode(value).byteLength <= maxBytes, `Text exceeds ${maxBytes} UTF-8 bytes`);
}

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: false, precision: 3 });
const CanonicalDisplayNameSchema = z.string().refine((value) => {
  try {
    return canonicalizeCertificateRecipientNameInput(value) === value;
  } catch {
    return false;
  }
}, "Display name must be canonical certificate-safe Unicode");
const DisplayNameInputSchema = z.string().refine((value) => {
  try {
    canonicalizeCertificateRecipientNameInput(value);
    return true;
  } catch {
    return false;
  }
}, "Display name must be valid certificate-safe Unicode").transform((value) =>
  canonicalizeCertificateRecipientNameInput(value));
const ReasonSchema = canonicalText(2_000).refine((value) => value.length > 0, "Reason is required");

export const CertificateStatusSchema = z.enum([
  "awaiting_recipient_name",
  "pending",
  "failed",
  "issued",
]);

export const ConfirmCertificateRecipientNameRequestSchema = z.object({
  expectedVersion: z.number().int().min(0).max(2_147_483_646),
  displayName: DisplayNameInputSchema,
}).strict();

const CertificateRecipientNameSchema = z.object({
  version: z.number().int().positive().max(2_147_483_647),
  displayName: CanonicalDisplayNameSchema,
  confirmedAt: TimestampSchema,
}).strict();

export const CertificateRecipientNameResponseSchema = z.object({
  schemaVersion: z.literal(1),
  recipientName: CertificateRecipientNameSchema.nullable(),
}).strict();

export const CertificateListQuerySchema = z.object({
  limit: z.preprocess(
    (value) => value === undefined
      ? 25
      : typeof value === "number"
        ? value
        : typeof value === "string" && /^(?:[1-9]|[1-9][0-9]|100)$/u.test(value)
          ? Number(value)
          : value,
    z.number().int().min(1).max(100),
  ),
  cursor: z.string().regex(/^v1\.[A-Za-z0-9_-]{1,512}$/u).optional(),
}).strict();

const CertificateFailureCodeSchema = z.enum([
  "snapshot_not_renderable",
  "render_failed",
  "storage_failed",
]);

export const CertificateBusinessNameSnapshotSchema = z.string()
  .refine(certificateBusinessNameSnapshotRenderable, "Business name is not certificate-renderable");
export const CertificateCourseTitleSnapshotSchema = z.string()
  .refine(certificateCourseTitleSnapshotRenderable, "Course title is not certificate-renderable");

const CertificateListItemBase = z.object({
  id: UuidSchema,
  courseCompletionId: UuidSchema,
  courseVersion: z.number().int().positive().max(2_147_483_647),
  completedAt: TimestampSchema,
}).strict();

const RenderableCertificateListItemBase = CertificateListItemBase.extend({
  snapshotRenderable: z.literal(true),
  businessName: CertificateBusinessNameSnapshotSchema,
  courseTitle: CertificateCourseTitleSnapshotSchema,
}).strict();

const UnrenderableCertificateListItemBase = CertificateListItemBase.extend({
  snapshotRenderable: z.literal(false),
  businessName: z.null(),
  courseTitle: z.null(),
}).strict();

const RenderableCertificateListItemSchema = z.discriminatedUnion("status", [
  RenderableCertificateListItemBase.extend({
    status: z.literal("awaiting_recipient_name"),
    recipientName: z.null(),
    issuedAt: z.null(),
    failureCode: z.null(),
  }).strict(),
  RenderableCertificateListItemBase.extend({
    status: z.literal("pending"),
    recipientName: CanonicalDisplayNameSchema,
    issuedAt: z.null(),
    failureCode: z.null(),
  }).strict(),
  RenderableCertificateListItemBase.extend({
    status: z.literal("failed"),
    recipientName: CanonicalDisplayNameSchema,
    issuedAt: z.null(),
    failureCode: CertificateFailureCodeSchema.exclude(["snapshot_not_renderable"]),
  }).strict(),
  RenderableCertificateListItemBase.extend({
    status: z.literal("issued"),
    recipientName: CanonicalDisplayNameSchema,
    issuedAt: TimestampSchema,
    failureCode: z.null(),
  }).strict(),
]);

const UnrenderableCertificateListItemSchema = z.discriminatedUnion("status", [
  UnrenderableCertificateListItemBase.extend({
    status: z.literal("awaiting_recipient_name"),
    recipientName: z.null(),
    issuedAt: z.null(),
    failureCode: z.null(),
  }).strict(),
  UnrenderableCertificateListItemBase.extend({
    status: z.literal("failed"),
    recipientName: CanonicalDisplayNameSchema,
    issuedAt: z.null(),
    failureCode: z.literal("snapshot_not_renderable"),
  }).strict(),
]);

export const CertificateListItemSchema = z.union([
  RenderableCertificateListItemSchema,
  UnrenderableCertificateListItemSchema,
]);

export const CertificateListResponseSchema = z.object({
  items: z.array(CertificateListItemSchema).max(100),
  nextCursor: z.string().regex(/^v1\.[A-Za-z0-9_-]{1,512}$/u).nullable(),
}).strict();

export const CreateCertificateDeliveryRequestSchema = z.object({
  reason: ReasonSchema,
}).strict();

export const CertificateDeliveryResponseSchema = z.object({
  status: z.literal("delivery_pending"),
}).strict();

export type ConfirmCertificateRecipientNameRequest = z.infer<
  typeof ConfirmCertificateRecipientNameRequestSchema
>;
export type CertificateRecipientNameResponse = z.infer<
  typeof CertificateRecipientNameResponseSchema
>;
export type CertificateListQuery = z.infer<typeof CertificateListQuerySchema>;
export type CertificateListItem = z.infer<typeof CertificateListItemSchema>;
export type CertificateListResponse = z.infer<typeof CertificateListResponseSchema>;
export type CreateCertificateDeliveryRequest = z.infer<
  typeof CreateCertificateDeliveryRequestSchema
>;
export type CertificateDeliveryResponse = z.infer<typeof CertificateDeliveryResponseSchema>;
