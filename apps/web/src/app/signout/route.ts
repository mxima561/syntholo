import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { sessionId } = await auth();
  if (sessionId) {
    const client = await clerkClient();
    await client.sessions.revokeSession(sessionId);
  }
  return NextResponse.redirect(new URL("/", request.url));
}
