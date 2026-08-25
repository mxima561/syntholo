import { NextResponse } from "next/server";
import { getNeonAuth } from "@syntholo/auth/server";
import { isNeonAuthConfigured } from "@syntholo/auth/config";

const isProtectedPath = (pathname: string) => pathname === "/learn" || pathname.startsWith("/learn/");

export default async function proxy(request: Request) {
  if (!isNeonAuthConfigured()) return NextResponse.next();
  const auth = getNeonAuth();
  if (!auth) return NextResponse.next();
  const url = new URL(request.url);
  if (!isProtectedPath(url.pathname)) return NextResponse.next();
  return auth.middleware({ loginUrl: "/signin" })(request as never);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
