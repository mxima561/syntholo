import { getRuntimeEnv } from "@/lib/config/env";

export async function getHighLevelLocation() {
  const config = getRuntimeEnv().highlevel;
  if (!config) throw new Error("HighLevel is not configured. Business OS remains in demo mode.");
  const response = await fetch(`https://services.leadconnectorhq.com/locations/${config.locationId}`, {
    headers: { Authorization: `Bearer ${config.apiKey}`, Version: "2021-07-28", Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`HighLevel returned ${response.status}.`);
  return response.json() as Promise<Record<string, unknown>>;
}
