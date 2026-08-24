import { describe, expect, it } from "vitest";
import {
  createStaffSessionCrypto,
  generateOpaqueSessionId,
  hashOpaqueSessionId,
  parseStaffSessionKeyRing,
} from "./session-crypto.js";

const keyOne = Buffer.alloc(32, 1).toString("base64url");
const keyTwo = Buffer.alloc(32, 2).toString("base64url");
const binding = {
  sessionHash: Buffer.alloc(32, 7),
  staffIdentityId: "00000000-0000-4000-8000-000000000007",
  accessSessionId: "session_staff_7",
};

describe("staff session cryptography", () => {
  it("round-trips one bounded token bundle with versioned AAD", () => {
    const crypto = createStaffSessionCrypto(
      parseStaffSessionKeyRing(`2:${keyTwo},1:${keyOne}`),
    );
    const encrypted = crypto.encryptTokenBundle(
      { accessToken: "access-token", refreshToken: "refresh-token" },
      binding,
    );

    expect(encrypted.keyVersion).toBe(2);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.tag).toHaveLength(16);
    expect(
      crypto.decryptTokenBundle(encrypted, binding),
    ).toEqual({ accessToken: "access-token", refreshToken: "refresh-token" });
  });

  it.each([
    ["tampered ciphertext", { ciphertext: Buffer.from("tampered") }, binding],
    [
      "wrong AAD",
      {},
      { ...binding, accessSessionId: "session_attacker" },
    ],
    ["unknown key", { keyVersion: 9 }, binding],
  ])("fails closed for %s", (_case, encryptedPatch, decryptBinding) => {
    const crypto = createStaffSessionCrypto(
      parseStaffSessionKeyRing(`2:${keyTwo},1:${keyOne}`),
    );
    const encrypted = crypto.encryptTokenBundle(
      { accessToken: "access-token", refreshToken: "refresh-token" },
      binding,
    );

    expect(() =>
      crypto.decryptTokenBundle(
        { ...encrypted, ...encryptedPatch },
        decryptBinding,
      ),
    ).toThrow("STAFF_SESSION_DECRYPT_FAILED");
  });

  it("keeps old decrypt keys while using the first configured key for rotation", () => {
    const oldCrypto = createStaffSessionCrypto(
      parseStaffSessionKeyRing(`1:${keyOne}`),
    );
    const oldEncrypted = oldCrypto.encryptTokenBundle(
      { accessToken: "old-access", refreshToken: "old-refresh" },
      binding,
    );
    const rotatedCrypto = createStaffSessionCrypto(
      parseStaffSessionKeyRing(`2:${keyTwo},1:${keyOne}`),
    );

    expect(rotatedCrypto.decryptTokenBundle(oldEncrypted, binding)).toEqual({
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });
    expect(
      rotatedCrypto.encryptTokenBundle(
        { accessToken: "new-access", refreshToken: "new-refresh" },
        binding,
      ).keyVersion,
    ).toBe(2);
  });

  it.each([
    "",
    `0:${keyOne}`,
    `1:${keyOne},1:${keyTwo}`,
    "1:not-base64url",
    `1:${Buffer.alloc(31).toString("base64url")}`,
    `1:${keyOne},`,
  ])("rejects malformed key ring %j without exposing it", (value) => {
    expect(() => parseStaffSessionKeyRing(value)).toThrow(
      "STAFF_SESSION_ENCRYPTION_KEYS_INVALID",
    );
    try {
      parseStaffSessionKeyRing(value);
    } catch (error) {
      expect(String(error)).toBe(
        "Error: STAFF_SESSION_ENCRYPTION_KEYS_INVALID",
      );
      expect(String(error)).not.toContain(keyOne);
    }
  });

  it("generates a 32-byte opaque browser credential and hashes the exact text", () => {
    const opaque = generateOpaqueSessionId();
    expect(opaque).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(opaque, "base64url")).toHaveLength(32);
    expect(hashOpaqueSessionId(opaque)).toHaveLength(32);
    expect(hashOpaqueSessionId(`${opaque}x`)).not.toEqual(
      hashOpaqueSessionId(opaque),
    );
  });

  it("rejects token material above the documented bound", () => {
    const crypto = createStaffSessionCrypto(
      parseStaffSessionKeyRing(`1:${keyOne}`),
    );
    expect(() =>
      crypto.encryptTokenBundle(
        { accessToken: "a".repeat(65_537), refreshToken: "refresh" },
        binding,
      ),
    ).toThrow("STAFF_TOKEN_BUNDLE_INVALID");
  });
});
