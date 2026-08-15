import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { createMuxPlaybackSigner } from "./mux-playback.js";

describe("Mux playback signer", () => {
  it("mints a resource-scoped duration-aware video token", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const signer = await createMuxPlaybackSigner({
      keyId: "mux-signing-key-1",
      privateKey: await exportPKCS8(privateKey),
    });
    const signed = await signer.sign({
      playbackId: "signed_playback_1",
      durationSeconds: 720,
      now: new Date("2026-08-15T12:00:00.000Z"),
    });
    expect(signed).toMatchObject({
      issuedAt: "2026-08-15T12:00:00.000Z",
      refreshAfter: "2026-08-15T12:04:00.000Z",
      expiresAt: "2026-08-15T12:14:00.000Z",
    });
    expect(decodeProtectedHeader(signed.playbackToken)).toMatchObject({ alg: "RS256", kid: "mux-signing-key-1" });
    expect(decodeJwt(signed.playbackToken)).toMatchObject({ sub: "signed_playback_1", aud: "v" });
  });

  it("accepts the documented base64-encoded PEM signing key", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const signer = await createMuxPlaybackSigner({
      keyId: "mux-signing-key-1",
      privateKey: Buffer.from(pem, "utf8").toString("base64"),
    });
    await expect(signer.sign({
      playbackId: "signed_playback_1",
      durationSeconds: 600,
      now: new Date("2026-08-15T12:00:00.000Z"),
    })).resolves.toMatchObject({ expiresAt: "2026-08-15T12:12:00.000Z" });
  });

  it("rejects malformed key material and caller-controlled resource input", async () => {
    await expect(createMuxPlaybackSigner({ keyId: "mux-key", privateKey: "not a key" }))
      .rejects.toThrow("MUX_SIGNING_CONFIG_INVALID");
    await expect(createMuxPlaybackSigner({
      keyId: "mux-key",
      privateKey: "not+canonical=base64===",
    })).rejects.toThrow("MUX_SIGNING_CONFIG_INVALID");
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const signer = await createMuxPlaybackSigner({ keyId: "mux-key", privateKey: await exportPKCS8(privateKey) });
    await expect(signer.sign({ playbackId: "bad/playback", durationSeconds: 720, now: new Date() }))
      .rejects.toThrow("MUX_SIGNING_INPUT_INVALID");
  });
});
