import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { accessCertsUrl, accessIssuer, getCachedRemoteJwks, readAccessToken, verifyAccessJwt } from "@/lib/auth/access-jwt";

function forbidden() {
  return new NextResponse("", { status: 403 });
}

export default async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();

  if (process.env.NODE_ENV !== "production" && !process.env.CF_ACCESS_AUD?.trim()) {
    if (process.env.ADMIN_DEV_BYPASS_EMAIL?.trim()) return NextResponse.next();
  }

  const token = readAccessToken({
    header: request.headers.get("cf-access-jwt-assertion"),
    cookie: request.cookies.get("CF_Authorization")?.value ?? null,
  });
  const aud = process.env.CF_ACCESS_AUD?.trim();
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
  if (!token || !aud || !teamDomain) return forbidden();

  const verified = await verifyAccessJwt(token, {
    aud,
    issuer: accessIssuer(teamDomain),
    jwks: getCachedRemoteJwks(accessCertsUrl(teamDomain)),
  });
  if (!verified.ok) return forbidden();
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
