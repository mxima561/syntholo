import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflareAccessAllows } from "./access-gate";

const verifyAccessJwt = vi.hoisted(() => vi.fn());
const readAccessToken = vi.hoisted(() => vi.fn());

vi.mock("./access-jwt", () => ({
  accessCertsUrl: (team: string) => `${team.replace(/\/$/, "")}/cdn-cgi/access/certs`,
  accessIssuer: (team: string) => team.replace(/\/$/, ""),
  getCachedRemoteJwks: () => ({}),
  readAccessToken,
  verifyAccessJwt,
}));

afterEach(() => {
  vi.clearAllMocks();
  readAccessToken.mockReturnValue("cf-token");
  verifyAccessJwt.mockResolvedValue({ ok: true });
});

describe("cloudflareAccessAllows", () => {
  it("rejects a request with no Access JWT in production (student hitting admin origin)", async () => {
    readAccessToken.mockReturnValue(null);
    await expect(
      cloudflareAccessAllows({
        header: null,
        cookie: null,
        env: {
          NODE_ENV: "production",
          VERCEL_ENV: "production",
          CF_ACCESS_AUD: "aud-tag",
          CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        },
      }),
    ).resolves.toBe(false);
    expect(verifyAccessJwt).not.toHaveBeenCalled();
  });

  it("rejects a request whose Access JWT fails JWKS/audience verification", async () => {
    verifyAccessJwt.mockResolvedValue({ ok: false });
    await expect(
      cloudflareAccessAllows({
        header: "forged",
        cookie: null,
        env: {
          NODE_ENV: "production",
          VERCEL_ENV: "production",
          CF_ACCESS_AUD: "aud-tag",
          CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        },
      }),
    ).resolves.toBe(false);
  });

  it("allows local development when Access is not configured", async () => {
    readAccessToken.mockReturnValue(null);
    await expect(
      cloudflareAccessAllows({
        header: null,
        cookie: null,
        env: { NODE_ENV: "development" },
      }),
    ).resolves.toBe(true);
  });

  it("allows Vercel preview when Access env is unset", async () => {
    readAccessToken.mockReturnValue(null);
    await expect(
      cloudflareAccessAllows({
        header: null,
        cookie: null,
        env: { NODE_ENV: "production", VERCEL_ENV: "preview" },
      }),
    ).resolves.toBe(true);
  });
});
