import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_BYTES = 65_536;

export interface EncryptedValue {
  keyVersion: number;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export interface StaffTokenBundle {
  accessToken: string;
  refreshToken: string;
}

export interface StaffTokenBinding {
  sessionHash: Buffer;
  staffIdentityId: string;
  workosSessionId: string;
}

export interface StaffSessionKeyRing {
  readonly activeVersion: number;
  readonly keys: ReadonlyMap<number, Buffer>;
}

function invalidKeys(): never {
  throw new Error("STAFF_SESSION_ENCRYPTION_KEYS_INVALID");
}

export function parseStaffSessionKeyRing(value: string): StaffSessionKeyRing {
  try {
    if (value.length === 0 || value.endsWith(",")) invalidKeys();
    const keys = new Map<number, Buffer>();
    for (const entry of value.split(",")) {
      const match = /^(\d+):([A-Za-z0-9_-]{43})$/u.exec(entry);
      if (!match) invalidKeys();
      const version = Number(match[1]);
      if (!Number.isSafeInteger(version) || version <= 0 || keys.has(version)) {
        invalidKeys();
      }
      const encoded = match[2] ?? "";
      const decoded = Buffer.from(encoded, "base64url");
      if (
        decoded.length !== KEY_BYTES ||
        decoded.toString("base64url") !== encoded
      ) {
        invalidKeys();
      }
      keys.set(version, decoded);
    }
    const activeVersion = keys.keys().next().value;
    if (typeof activeVersion !== "number") invalidKeys();
    return Object.freeze({ activeVersion, keys });
  } catch {
    invalidKeys();
  }
}

function bindingAad(binding: StaffTokenBinding): Buffer {
  if (
    binding.sessionHash.length !== 32 ||
    binding.staffIdentityId.length === 0 ||
    binding.workosSessionId.length === 0
  ) {
    throw new Error("STAFF_SESSION_BINDING_INVALID");
  }
  return Buffer.from(
    JSON.stringify([
      "syntholo-staff-session-v1",
      binding.sessionHash.toString("base64url"),
      binding.staffIdentityId,
      binding.workosSessionId,
    ]),
  );
}

function encrypt(
  plaintext: Buffer,
  aad: Buffer,
  keyRing: StaffSessionKeyRing,
): EncryptedValue {
  const key = keyRing.keys.get(keyRing.activeVersion);
  if (!key) throw new Error("STAFF_SESSION_ENCRYPT_FAILED");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    keyVersion: keyRing.activeVersion,
    iv,
    ciphertext,
    tag: cipher.getAuthTag(),
  };
}

function decrypt(
  encrypted: EncryptedValue,
  aad: Buffer,
  keyRing: StaffSessionKeyRing,
): Buffer {
  try {
    const key = keyRing.keys.get(encrypted.keyVersion);
    if (
      !key ||
      encrypted.iv.length !== IV_BYTES ||
      encrypted.tag.length !== TAG_BYTES
    ) {
      throw new Error("invalid encrypted value");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(encrypted.tag);
    return Buffer.concat([
      decipher.update(encrypted.ciphertext),
      decipher.final(),
    ]);
  } catch {
    throw new Error("STAFF_SESSION_DECRYPT_FAILED");
  }
}

function validateToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_TOKEN_BYTES
  ) {
    throw new Error("STAFF_TOKEN_BUNDLE_INVALID");
  }
  return value;
}

export function createStaffSessionCrypto(keyRing: StaffSessionKeyRing) {
  return Object.freeze({
    encryptTokenBundle(
      bundle: StaffTokenBundle,
      binding: StaffTokenBinding,
    ): EncryptedValue {
      const accessToken = validateToken(bundle.accessToken);
      const refreshToken = validateToken(bundle.refreshToken);
      return encrypt(
        Buffer.from(JSON.stringify({ accessToken, refreshToken })),
        bindingAad(binding),
        keyRing,
      );
    },
    decryptTokenBundle(
      encrypted: EncryptedValue,
      binding: StaffTokenBinding,
    ): StaffTokenBundle {
      try {
        const parsed: unknown = JSON.parse(
          decrypt(encrypted, bindingAad(binding), keyRing).toString("utf8"),
        );
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error("invalid token bundle");
        }
        const record = parsed as Record<string, unknown>;
        return {
          accessToken: validateToken(record.accessToken),
          refreshToken: validateToken(record.refreshToken),
        };
      } catch {
        throw new Error("STAFF_SESSION_DECRYPT_FAILED");
      }
    },
    encryptSecret(value: string, aad: string): EncryptedValue {
      if (
        value.length === 0 ||
        Buffer.byteLength(value) > MAX_TOKEN_BYTES ||
        aad.length === 0
      ) {
        throw new Error("STAFF_SESSION_ENCRYPT_FAILED");
      }
      return encrypt(Buffer.from(value), Buffer.from(aad), keyRing);
    },
    decryptSecret(encrypted: EncryptedValue, aad: string): string {
      return decrypt(encrypted, Buffer.from(aad), keyRing).toString("utf8");
    },
  });
}

export type StaffSessionCrypto = ReturnType<typeof createStaffSessionCrypto>;

export function generateOpaqueSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueSessionId(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
