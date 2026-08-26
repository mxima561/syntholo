import { createClient } from "@neondatabase/neon-js";
import { isNeonDataApiConfigured, neonDataApiUrl, neonPublicAuthUrl } from "./config";

export type NeonDataClient = ReturnType<typeof createClient>;

export function createNeonBrowserClient(): NeonDataClient | null {
  if (!isNeonDataApiConfigured()) return null;
  return createClient({
    auth: { url: neonPublicAuthUrl() },
    dataApi: { url: neonDataApiUrl() },
  });
}

export function createNeonDataClient(accessToken: string): NeonDataClient | null {
  if (!isNeonDataApiConfigured()) return null;
  return createClient({
    dataApi: {
      url: neonDataApiUrl(),
      getToken: async () => accessToken,
    },
  });
}
