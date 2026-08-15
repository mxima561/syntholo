import fontRepertoire from "./certificate-font-repertoire.v1.json";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const CERTIFICATE_FONT_REPERTOIRE_MANIFEST_SHA256 =
  fontRepertoire.manifestCanonicalSha256;
export const CERTIFICATE_FONT_REPERTOIRE = Object.freeze(fontRepertoire);

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

function validUnicodeScalarSequence(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    }
  }
  return true;
}

function invalidAccountNameScalar(codePoint: number): boolean {
  return codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || [0xa0, 0xad, 0x61c, 0x1680, 0x180e, 0x3000, 0xfeff].includes(codePoint)
    || (codePoint >= 0x2000 && codePoint <= 0x200f)
    || (codePoint >= 0x2028 && codePoint <= 0x202f)
    || (codePoint >= 0x205f && codePoint <= 0x206f)
    || (codePoint >= 0xfdd0 && codePoint <= 0xfdef)
    || (codePoint & 0xffff) === 0xfffe
    || (codePoint & 0xffff) === 0xffff;
}

export function certificateBusinessNameRenderable(value: string): boolean {
  if (!validUnicodeScalarSequence(value)) return false;
  const scalars = Array.from(value);
  const byteLength = new TextEncoder().encode(value).byteLength;
  return value.length > 0
    && value === value.normalize("NFC")
    && value === value.replace(/^ +| +$/gu, "")
    && byteLength >= 1
    && byteLength <= 255
    && scalars.every((scalar) => !invalidAccountNameScalar(scalar.codePointAt(0)!))
    && scalars.every((scalar) => certificateFontSupportsScalar(scalar.codePointAt(0)!));
}

export function certificateCourseTitleRenderable(value: string): boolean {
  if (!validUnicodeScalarSequence(value)) return false;
  const scalars = Array.from(value);
  return scalars.length >= 1
    && scalars.length <= 255
    && value === value.normalize("NFC")
    && new TextEncoder().encode(value).byteLength <= 1_020
    && scalars.every((scalar) => !invalidRecipientScalar(scalar.codePointAt(0)!))
    && scalars.every((scalar) => certificateFontSupportsScalar(scalar.codePointAt(0)!));
}

export function canonicalizeCertificateRecipientName(input: string): string {
  if (!validUnicodeScalarSequence(input)) throw new Error("CERTIFICATE_RECIPIENT_NAME_INVALID");
  if (Array.from(input).length > 256 || new TextEncoder().encode(input).byteLength > 1_024) {
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
    || new TextEncoder().encode(canonical).byteLength > 480
  ) throw new Error("CERTIFICATE_RECIPIENT_NAME_INVALID");
  return canonical;
}

type AuthorityTuple = Readonly<{
  id: string;
  accountId: string;
  membershipId: string;
  enrollmentId: string;
  courseId: string;
  courseVersionId: string;
}>;

type EligibilityInput = Readonly<{
  prerequisite: AuthorityTuple & Readonly<{ courseCompletionId: string }>;
  completion: AuthorityTuple & Readonly<{ completedAt: string }>;
}>;

export type CertificateAuthoritySnapshot = Readonly<{
  accountId: string;
  membershipId: string;
  enrollmentId: string;
  courseId: string;
  courseVersionId: string;
  courseCompletionId: string;
  certificatePrerequisiteId: string;
  completedAt: string;
}>;

function canonicalUuid(value: string): boolean {
  return uuidPattern.test(value);
}

export function certificateObjectKey(input: Readonly<{
  accountId: string;
  courseCompletionId: string;
}>): string {
  if (!canonicalUuid(input.accountId) || !canonicalUuid(input.courseCompletionId)) {
    throw new Error("CERTIFICATE_IDENTITY_INVALID");
  }
  return `certificates/v1/${input.accountId}/${input.courseCompletionId}.pdf`;
}

export function certificateJobIdentity(courseCompletionId: string): Readonly<{
  jobType: "learning.course_completed.certificate.v1";
  idempotencyKey: string;
}> {
  if (!canonicalUuid(courseCompletionId)) throw new Error("CERTIFICATE_IDENTITY_INVALID");
  return Object.freeze({
    jobType: "learning.course_completed.certificate.v1",
    idempotencyKey: `certificate:${courseCompletionId}`,
  });
}

export function assertCertificateEligibility(input: EligibilityInput): CertificateAuthoritySnapshot {
  const prerequisite = input.prerequisite;
  const completion = input.completion;
  const tupleMatches = prerequisite.courseCompletionId === completion.id
    && prerequisite.accountId === completion.accountId
    && prerequisite.membershipId === completion.membershipId
    && prerequisite.enrollmentId === completion.enrollmentId
    && prerequisite.courseId === completion.courseId
    && prerequisite.courseVersionId === completion.courseVersionId;
  const identifiers = [
    prerequisite.id,
    prerequisite.courseCompletionId,
    prerequisite.accountId,
    prerequisite.membershipId,
    prerequisite.enrollmentId,
    prerequisite.courseId,
    prerequisite.courseVersionId,
    completion.id,
    completion.accountId,
    completion.membershipId,
    completion.enrollmentId,
    completion.courseId,
    completion.courseVersionId,
  ];
  const completedAt = new Date(completion.completedAt);
  if (
    !tupleMatches
    || identifiers.some((identifier) => !canonicalUuid(identifier))
    || !Number.isFinite(completedAt.getTime())
    || completedAt.toISOString() !== completion.completedAt
  ) throw new Error("CERTIFICATE_ELIGIBILITY_INVALID");
  return Object.freeze({
    accountId: completion.accountId,
    membershipId: completion.membershipId,
    enrollmentId: completion.enrollmentId,
    courseId: completion.courseId,
    courseVersionId: completion.courseVersionId,
    courseCompletionId: completion.id,
    certificatePrerequisiteId: prerequisite.id,
    completedAt: completion.completedAt,
  });
}

export function nextRecipientNameVersion(currentVersion: number, expectedVersion: number): number {
  if (
    !Number.isInteger(currentVersion)
    || currentVersion < 0
    || currentVersion > 2_147_483_646
    || expectedVersion !== currentVersion
  ) throw new Error("VERSION_CONFLICT");
  return currentVersion + 1;
}

export type CertificateStatus =
  | "awaiting_recipient_name"
  | "pending"
  | "failed"
  | "issued";

type CertificateTransition =
  | "name_bound"
  | "name_bound_unrenderable"
  | "issued"
  | "failed"
  | "retry_authorized";

export function nextCertificateStatus(
  current: CertificateStatus,
  transition: CertificateTransition,
  currentFailureCode: "snapshot_not_renderable" | "render_failed" | "storage_failed" | null = null,
): CertificateStatus {
  if (current === "awaiting_recipient_name" && transition === "name_bound") return "pending";
  if (current === "awaiting_recipient_name" && transition === "name_bound_unrenderable") {
    return "failed";
  }
  if (current === "pending" && (transition === "issued" || transition === "failed")) return transition;
  if (
    current === "failed"
    && transition === "retry_authorized"
    && currentFailureCode === "storage_failed"
  ) return "pending";
  if (current === "issued" && transition === "issued") return "issued";
  throw new Error("CERTIFICATE_TRANSITION_INVALID");
}
