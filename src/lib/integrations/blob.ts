import { put } from "@vercel/blob";
import { getRuntimeEnv } from "@/lib/config/env";

export async function uploadPrivateArtifact(pathname: string, body: Blob | Buffer) {
  const token = getRuntimeEnv().blobToken;
  if (!token) throw new Error("Vercel Blob is not configured. Uploads stay local in demo mode.");
  return put(pathname, body, { access: "private", token, addRandomSuffix: true });
}
