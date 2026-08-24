import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const clerkReady = Boolean(
  process.env.CLERK_SECRET_KEY?.trim() && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim(),
);

const isProtectedRoute = createRouteMatcher(["/learn(.*)"]);

const clerk = clerkReady
  ? clerkMiddleware(async (auth, request) => {
      if (isProtectedRoute(request)) await auth.protect();
    })
  : null;

export default function proxy(...args: Parameters<NonNullable<typeof clerk>>) {
  if (!clerk) return NextResponse.next();
  return clerk(...args);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
