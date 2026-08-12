import { getRuntimeEnv } from "@/lib/config/env";
import type { VideoAdapter } from "./contracts";

export class MuxVideoAdapter implements VideoAdapter {
  async getPlayback({ playbackId }: { playbackId: string }) {
    if (!getRuntimeEnv().mux) throw new Error("Mux is not configured. Demo video placeholders are active.");
    return { playbackId, posterUrl: `https://image.mux.com/${playbackId}/thumbnail.webp?time=1` };
  }
}
