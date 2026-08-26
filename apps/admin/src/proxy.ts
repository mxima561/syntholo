import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cloudflareAccessAllows } from "@/lib/auth/access-gate";

function forbidden() {
  return new NextResponse("", { status: 403 });
}

function isNeonPublicPath(pathname: string) {
  return pathname === "/login" || pathname.startsWith("/api/auth");
}

export default async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();

  const accessOk = await cloudflareAccessAllows({
    header: request.headers.get("cf-access-jwt-assertion"),
    cookie: request.cookies.get("CF_Authorization")?.value ?? null,
  });
  if (!accessOk) return forbidden();

  const response = NextResponse.next();
  if (isNeonPublicPath(request.nextUrl.pathname)) {
    response.headers.set("x-syntholo-admin-public", "1");
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
