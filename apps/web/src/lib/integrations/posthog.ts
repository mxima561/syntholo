import { getRuntimeEnv } from "@/lib/config/env";
import type { AnalyticsAdapter } from "@/lib/analytics/types";

export class PostHogAnalyticsAdapter implements AnalyticsAdapter {
  async capture(input: { event: string; distinctId: string; properties?: Record<string, unknown> }) {
    const config = getRuntimeEnv().posthog;
    if (!config) return;
    const response = await fetch(`${config.host}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: config.key, event: input.event, distinct_id: input.distinctId, properties: input.properties }),
    });
    if (!response.ok) throw new Error(`PostHog capture failed with ${response.status}.`);
  }
}
