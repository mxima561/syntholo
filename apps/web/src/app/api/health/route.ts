import { NextResponse } from "next/server";
import { getRuntimeEnv } from "@/lib/config/env";

export function GET() {
  try {
    const env = getRuntimeEnv();
    return NextResponse.json({
      ok: true,
      mode: env.mode,
      integrations: {
        mongodb: Boolean(env.mongodb), clerk: Boolean(env.clerk), stripe: Boolean(env.stripe), mux: Boolean(env.mux),
        resend: Boolean(env.resend), posthog: Boolean(env.posthog), blob: Boolean(env.blobToken), highlevel: Boolean(env.highlevel),
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Invalid runtime configuration." }, { status: 503 });
  }
}
