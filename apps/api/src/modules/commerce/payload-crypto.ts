import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for customer-supplied commerce payloads (contact
 * details, business name, claim delivery tokens). PostgreSQL stores only the
 * ciphertext, nonce, tag, and key id, so plaintext never lands in a row, an
 * index, a log, or an analytics event.
 *
 * The associated data binds a sealed payload to the field it was sealed for, so
 * a contact ciphertext cannot be replayed into a business-name column.
 */

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 4096;

const keyId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface CommercePayloadKeyRing {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface SealedCommercePayload {
  readonly keyId: string;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
}

function invalidKeys(): never {
  throw new Error("COMMERCE_PAYLOAD_KEYS_INVALID");
}

function unsealFailed(): never {
  throw new Error("COMMERCE_PAYLOAD_UNSEAL_FAILED");
}

/**
 * Parses `keyId:base64url,keyId:base64url`. The first entry is the active key;
 * later entries stay available so payloads sealed before a rotation can still
 * be opened.
 */
export function parseCommercePayloadKeyRing(value: string): CommercePayloadKeyRing {
  if (value.length === 0 || value.endsWith(",")) invalidKeys();
  const keys = new Map<string, Buffer>();
  let activeKeyId: string | undefined;
  for (const entry of value.split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0) invalidKeys();
    const id = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    if (!keyId.test(id) || keys.has(id)) invalidKeys();
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.length !== KEY_BYTES || decoded.toString("base64url") !== encoded) {
      invalidKeys();
    }
    keys.set(id, decoded);
    activeKeyId ??= id;
  }
  if (activeKeyId === undefined) invalidKeys();
  return Object.freeze({ activeKeyId, keys });
}

export function sealCommercePayload(
  ring: CommercePayloadKeyRing,
  plaintext: string,
  associatedData: string,
): SealedCommercePayload {
  const key = ring.keys.get(ring.activeKeyId);
  const value = Buffer.from(plaintext, "utf8");
  if (key === undefined || value.byteLength === 0 || value.byteLength > MAX_PLAINTEXT_BYTES) {
    invalidKeys();
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Object.freeze({
    keyId: ring.activeKeyId,
    ciphertext,
    nonce,
    tag: cipher.getAuthTag(),
  });
}

export function openCommercePayload(
  ring: CommercePayloadKeyRing,
  sealed: SealedCommercePayload,
  associatedData: string,
): string {
  const key = ring.keys.get(sealed.keyId);
  if (
    key === undefined
    || sealed.nonce.byteLength !== NONCE_BYTES
    || sealed.tag.byteLength !== TAG_BYTES
    || sealed.ciphertext.byteLength === 0
  ) {
    unsealFailed();
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce));
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.tag));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    unsealFailed();
  }
}

/**
 * Keyed, deterministic fingerprint used to match a buyer to their purchase
 * without storing the address in a searchable column. Keyed so the value cannot
 * be reversed with a dictionary of common addresses.
 */
export function contactEmailFingerprint(
  ring: CommercePayloadKeyRing,
  email: string,
): Buffer {
  const key = ring.keys.get(ring.activeKeyId);
  if (key === undefined) invalidKeys();
  return createHmac("sha256", key)
    .update(`commerce-contact-email.v1\n${email.trim().toLowerCase()}`, "utf8")
    .digest();
}

/** Content hash of the canonical business name, matching the account-name contract. */
export function canonicalBusinessNameHash(businessName: string): string {
  return createHash("sha256")
    .update(`commerce-business-name.v1\n${businessName.normalize("NFC").trim()}`, "utf8")
    .digest("hex");
}
