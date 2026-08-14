export type CanonicalHostConfig = Readonly<{
  mode: "demo" | "production";
  webOrigin: string;
}>;

export function canonicalRedirectTarget(
  requestUrl: URL,
  config: CanonicalHostConfig,
): string | undefined {
  if (config.mode !== "production" || requestUrl.origin === config.webOrigin) {
    return undefined;
  }
  const target = new URL(config.webOrigin);
  target.pathname = requestUrl.pathname;
  target.search = requestUrl.search;
  return target.toString();
}
