import { NextResponse } from "next/server";
import { getNeonAuth } from "@syntholo/auth/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = getNeonAuth();
  if (auth) {
    await auth.signOut?.().catch(() => undefined);
  }
  return NextResponse.redirect(new URL("/", request.url));
}
