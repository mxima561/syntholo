/**
 * Unified Neon client for Syntholo web.
 * Browser-safe Auth + Data API URLs only. Privileged DATABASE_URL stays server-side.
 */
export { createNeonBrowserClient, createNeonDataClient } from "@syntholo/auth/neon";
export { isNeonAuthConfigured, isNeonDataApiConfigured, neonGoogleAuthEnabled } from "@syntholo/auth/config";
export { getNeonAccessToken, getNeonAuth, getNeonAuthUser } from "@syntholo/auth/server";
