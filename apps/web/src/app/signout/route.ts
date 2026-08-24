import { NextResponse } from "next/server";
import { signOut } from "@workos-inc/authkit-nextjs";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await signOut({ returnTo: "/" });
  } catch {
    // No active session; just send them home.
  }
  return NextResponse.redirect(new URL("/", request.url));
}
