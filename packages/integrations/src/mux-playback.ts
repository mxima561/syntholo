import { importPKCS8, SignJWT } from "jose";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

export class MuxPlaybackDependencyUnavailableError extends Error {
  constructor() {
    super("MUX_PLAYBACK_DEPENDENCY_UNAVAILABLE");
    this.name = "MuxPlaybackDependencyUnavailableError";
  }
}

export type MuxPlaybackSigner = Readonly<{
  sign(input: Readonly<{ playbackId: string; durationSeconds: number; now: Date }>): Promise<Readonly<{
    playbackToken: string;
    issuedAt: string;
    refreshAfter: string;
    expiresAt: string;
  }>>;
}>;

function exactTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("MUX_SIGNING_INPUT_INVALID");
  return value.toISOString();
}

function hasPkcs8Envelope(value: string): boolean {
  return value.length >= 100
    && value.length <= 16_384
    && !value.includes("\0")
    && value.startsWith("-----BEGIN PRIVATE KEY-----")
    && value.endsWith("-----END PRIVATE KEY-----");
}

export function decodeMuxSigningPrivateKey(value: string): string {
  const candidate = value.trim();
  if (hasPkcs8Envelope(candidate)) return candidate;
  if (candidate.length < 128 || candidate.length > 24_000
    || candidate.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(candidate)) {
    throw new Error("MUX_SIGNING_CONFIG_INVALID");
  }
  const bytes = Buffer.from(candidate, "base64");
  if (bytes.toString("base64") !== candidate) throw new Error("MUX_SIGNING_CONFIG_INVALID");
  const decoded = bytes.toString("utf8").trim();
  if (!hasPkcs8Envelope(decoded)) throw new Error("MUX_SIGNING_CONFIG_INVALID");
  return decoded;
}

export async function createMuxPlaybackSigner(input: Readonly<{
  keyId: string;
  privateKey: string;
}>): Promise<MuxPlaybackSigner> {
  if (!identifier.test(input.keyId)) {
    throw new Error("MUX_SIGNING_CONFIG_INVALID");
  }
  const privateKey = decodeMuxSigningPrivateKey(input.privateKey);
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(privateKey, "RS256");
  } catch {
    throw new Error("MUX_SIGNING_CONFIG_INVALID");
  }
  return Object.freeze({
    async sign(signingInput) {
      if (!identifier.test(signingInput.playbackId) || !Number.isSafeInteger(signingInput.durationSeconds) || signingInput.durationSeconds < 300 || signingInput.durationSeconds > 720) {
        throw new Error("MUX_SIGNING_INPUT_INVALID");
      }
      const issuedAt = new Date(signingInput.now);
      const ttlSeconds = Math.min(900, Math.max(300, signingInput.durationSeconds + 120));
      const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1_000);
      const refreshAfter = new Date(Math.min(
        issuedAt.getTime() + 240_000,
        expiresAt.getTime() - 90_000,
      ));
      const playbackToken = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: input.keyId, typ: "JWT" })
        .setSubject(signingInput.playbackId)
        .setAudience("v")
        .setIssuedAt(Math.floor(issuedAt.getTime() / 1_000))
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
        .sign(key);
      return Object.freeze({
        playbackToken,
        issuedAt: exactTimestamp(issuedAt),
        refreshAfter: exactTimestamp(refreshAfter),
        expiresAt: exactTimestamp(expiresAt),
      });
    },
  });
}
