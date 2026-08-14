import { NextResponse } from "next/server";
import { createWebHealthResponse } from "./health";

export function GET() {
  const response = createWebHealthResponse(
    process.env,
    process.env.NEXT_PUBLIC_RELEASE_SHA,
  );
  return NextResponse.json(response.body, { status: response.status });
}
