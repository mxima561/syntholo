#!/usr/bin/env node
import { createServer } from "node:http";

const port = Number.parseInt(process.env.PROXY_FIXTURE_PORT ?? "4100", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PROXY_FIXTURE_PORT_INVALID");
}

const server = createServer((request, response) => {
  if (request.url !== "/v1/proxy-evidence") {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.setHeader("location", "/v1/proxy-target");
  response.setHeader("set-cookie", [
    "proxy_a=one; Path=/; HttpOnly; SameSite=Lax",
    "proxy_b=two; Path=/; Secure; SameSite=None",
  ]);
  response.writeHead(207).end(JSON.stringify({
    authorization: request.headers.authorization ?? null,
    cookie: request.headers.cookie ?? null,
    method: request.method,
    path: request.url,
  }));
});

server.listen(port, "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
