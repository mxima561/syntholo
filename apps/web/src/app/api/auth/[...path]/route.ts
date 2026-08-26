import { getNeonAuth } from "@syntholo/auth/server";

const auth = getNeonAuth();
const handlers = auth?.handler();

async function unavailable() {
  return new Response("Neon Auth is not configured.", { status: 503 });
}

export const GET = handlers?.GET ?? unavailable;
export const POST = handlers?.POST ?? unavailable;
