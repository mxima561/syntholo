import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseWebApiConfig } from "./lib/api/config";
import {
  canonicalRedirectTarget,
  vercelCanonicalRequestUrl,
} from "./lib/config/canonical-host";

export function proxy(request: NextRequest) {
  const config = parseWebApiConfig(process.env);
  const target = canonicalRedirectTarget(vercelCanonicalRequestUrl(
    new URL(request.url),
    request.headers,
    {
      vercel: process.env.VERCEL,
      vercelEnvironment: process.env.VERCEL_ENV,
      webOrigin: config.webOrigin,
    },
  ), config);
  return target === undefined
    ? NextResponse.next()
    : NextResponse.redirect(target, 308);
}

export const config = {
  matcher: "/:path*",
};
