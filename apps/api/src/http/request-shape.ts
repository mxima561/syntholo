import type { FastifyRequest } from "fastify";

export function requestHasBody(request: FastifyRequest): boolean {
  const contentLengths: string[] = [];
  let transferEncoding = false;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    const name = request.raw.rawHeaders[index]?.toLowerCase();
    if (name === "content-length") contentLengths.push(request.raw.rawHeaders[index + 1] ?? "");
    if (name === "transfer-encoding") transferEncoding = true;
  }
  return transferEncoding
    || contentLengths.length > 1
    || contentLengths.some((value) => value !== "0")
    || request.body !== undefined;
}

export function queryIsEmpty(query: unknown): boolean {
  return typeof query === "object"
    && query !== null
    && !Array.isArray(query)
    && Object.keys(query).length === 0;
}
