export type ParsedVideo = { kind: "embed" | "file"; url: string };

export function toEmbedUrl(src: string): ParsedVideo | null {
  let parsed: URL;
  try {
    parsed = new URL(src);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "youtube.com" || host === "m.youtube.com") {
    const id = parsed.searchParams.get("v");
    if (id) return { kind: "embed", url: `https://www.youtube.com/embed/${id}` };
  }
  if (host === "youtu.be") {
    const id = parsed.pathname.replace(/^\/+/, "");
    if (id) return { kind: "embed", url: `https://www.youtube.com/embed/${id}` };
  }
  if (host === "vimeo.com") {
    const id = parsed.pathname.replace(/^\/+/, "");
    if (/^\d+$/.test(id)) return { kind: "embed", url: `https://player.vimeo.com/video/${id}` };
  }
  if (/\.(mp4|webm|mov|m4v)$/i.test(parsed.pathname)) {
    return { kind: "file", url: src };
  }
  return { kind: "embed", url: src };
}
