import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalBusinessNameHash,
  contactEmailFingerprint,
  openCommercePayload,
  parseCommercePayloadKeyRing,
  sealCommercePayload,
} from "./payload-crypto.js";

const keyOne = randomBytes(32).toString("base64url");
const keyTwo = randomBytes(32).toString("base64url");
const ring = `contact-k2:${keyTwo},contact-k1:${keyOne}`;

describe("parseCommercePayloadKeyRing", () => {
  it("treats the first entry as the active key and retains earlier keys", () => {
    const parsed = parseCommercePayloadKeyRing(ring);

    expect(parsed.activeKeyId).toBe("contact-k2");
    expect([...parsed.keys.keys()].sort()).toEqual(["contact-k1", "contact-k2"]);
  });

  it.each([
    ["", "empty"],
    ["contact-k1", "missing key material"],
    ["contact-k1:short", "key that is not 32 bytes"],
    [`contact-k1:${keyOne},contact-k1:${keyTwo}`, "duplicate key id"],
    [`bad id:${keyOne}`, "key id outside the allowed alphabet"],
    [`contact-k1:${keyOne},`, "trailing separator"],
  ])("rejects %s (%s)", (value) => {
    expect(() => parseCommercePayloadKeyRing(value)).toThrow(
      "COMMERCE_PAYLOAD_KEYS_INVALID",
    );
  });
});

describe("sealCommercePayload", () => {
  it("round-trips a payload under the active key", () => {
    const parsed = parseCommercePayloadKeyRing(ring);
    const sealed = sealCommercePayload(parsed, "owner@example.test", "contact");

    expect(sealed.keyId).toBe("contact-k2");
    expect(sealed.nonce.byteLength).toBe(12);
    expect(sealed.tag.byteLength).toBe(16);
    expect(openCommercePayload(parsed, sealed, "contact")).toBe("owner@example.test");
  });

  it("never emits the plaintext inside the ciphertext", () => {
    const parsed = parseCommercePayloadKeyRing(ring);
    const sealed = sealCommercePayload(parsed, "owner@example.test", "contact");

    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain("owner@");
  });

  it("uses a fresh nonce for identical plaintext", () => {
    const parsed = parseCommercePayloadKeyRing(ring);
    const first = sealCommercePayload(parsed, "owner@example.test", "contact");
    const second = sealCommercePayload(parsed, "owner@example.test", "contact");

    expect(Buffer.from(first.nonce).equals(Buffer.from(second.nonce))).toBe(false);
    expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);
  });

  it("opens a payload sealed under a retired key", () => {
    const previous = parseCommercePayloadKeyRing(`contact-k1:${keyOne}`);
    const sealed = sealCommercePayload(previous, "owner@example.test", "contact");
    const rotated = parseCommercePayloadKeyRing(ring);

    expect(openCommercePayload(rotated, sealed, "contact")).toBe("owner@example.test");
  });

  it("refuses to open a payload whose associated data differs", () => {
    const parsed = parseCommercePayloadKeyRing(ring);
    const sealed = sealCommercePayload(parsed, "owner@example.test", "contact");

    expect(() => openCommercePayload(parsed, sealed, "business_name")).toThrow(
      "COMMERCE_PAYLOAD_UNSEAL_FAILED",
    );
  });

  it("refuses to open a payload whose tag was altered", () => {
    const parsed = parseCommercePayloadKeyRing(ring);
    const sealed = sealCommercePayload(parsed, "owner@example.test", "contact");
    const tampered = { ...sealed, tag: Buffer.alloc(16, 9) };

    expect(() => openCommercePayload(parsed, tampered, "contact")).toThrow(
      "COMMERCE_PAYLOAD_UNSEAL_FAILED",
    );
  });

  it("refuses to open a payload sealed under an unknown key", () => {
    const parsed = parseCommercePayloadKeyRing(ring);
    const sealed = sealCommercePayload(parsed, "owner@example.test", "contact");

    expect(() =>
      openCommercePayload(parsed, { ...sealed, keyId: "contact-k9" }, "contact"),
    ).toThrow("COMMERCE_PAYLOAD_UNSEAL_FAILED");
  });
});

describe("contactEmailFingerprint", () => {
  it("is a stable 32-byte value for the same normalized email", () => {
    const parsed = parseCommercePayloadKeyRing(ring);
    const first = contactEmailFingerprint(parsed, "Owner@Example.test");
    const second = contactEmailFingerprint(parsed, "  owner@example.test  ");

    expect(first.byteLength).toBe(32);
    expect(first.equals(second)).toBe(true);
  });

  it("differs for different emails and for a different key ring", () => {
    const parsed = parseCommercePayloadKeyRing(ring);
    const other = parseCommercePayloadKeyRing(`contact-k1:${keyOne}`);

    expect(
      contactEmailFingerprint(parsed, "a@example.test")
        .equals(contactEmailFingerprint(parsed, "b@example.test")),
    ).toBe(false);
    expect(
      contactEmailFingerprint(parsed, "a@example.test")
        .equals(contactEmailFingerprint(other, "a@example.test")),
    ).toBe(false);
  });
});

describe("canonicalBusinessNameHash", () => {
  it("returns a lowercase 64 character digest that ignores edge whitespace", () => {
    const value = canonicalBusinessNameHash("  Syntholo Studio  ");

    expect(value).toMatch(/^[0-9a-f]{64}$/u);
    expect(value).toBe(canonicalBusinessNameHash("Syntholo Studio"));
  });

  it("distinguishes different names", () => {
    expect(canonicalBusinessNameHash("Syntholo Studio")).not.toBe(
      canonicalBusinessNameHash("Syntholo Studios"),
    );
  });
});
