import { createHash } from "node:crypto";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

function canonical(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CONTENT_MANIFEST_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("CONTENT_MANIFEST_INVALID");
  const object = value as { readonly [key: string]: Json };
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key] as Json)}`).join(",")}}`;
}

export function canonicalContentManifest(manifest: unknown): string {
  try {
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("invalid");
    return canonical(manifest as Json);
  } catch {
    throw new Error("CONTENT_MANIFEST_INVALID");
  }
}

export function contentManifestHash(manifest: unknown): string {
  return createHash("sha256").update(canonicalContentManifest(manifest), "utf8").digest("hex");
}
