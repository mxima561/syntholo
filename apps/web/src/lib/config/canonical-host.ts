export type CanonicalHostConfig = Readonly<{
  mode: "demo" | "production";
  webOrigin: string;
}>;

export function vercelCanonicalRequestUrl(
  requestUrl: URL,
  headers: Headers,
  config: Readonly<{
    vercel: string | undefined;
    vercelEnvironment: string | undefined;
    webOrigin: string;
  }>,
): URL {
  const vercelRequestId = headers.get("x-vercel-id");
  const isInternalLoopback = requestUrl.port !== ""
    && (requestUrl.hostname === "127.0.0.1"
      || requestUrl.hostname === "::1"
      || requestUrl.hostname === "localhost");
  if (
    config.vercel !== "1"
    || config.vercelEnvironment !== "production"
    || !isInternalLoopback
    || vercelRequestId === null
    || !/^[a-z0-9-]+::[a-z0-9-]+$/iu.test(vercelRequestId)
  ) return requestUrl;
  const external = new URL(config.webOrigin);
  external.pathname = requestUrl.pathname;
  external.search = requestUrl.search;
  return external;
}

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
