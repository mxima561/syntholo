import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ ok: true, app: "admin", checkedAt: new Date().toISOString() });
}
