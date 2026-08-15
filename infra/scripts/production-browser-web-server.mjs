#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const certificateRoot = mkdtempSync(join(tmpdir(), "syntholo-browser-tls-"));
const certificate = join(certificateRoot, "certificate.pem");
const key = join(certificateRoot, "key.pem");

execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", key,
  "-out", certificate,
  "-subj", "/CN=app.syntholo.test",
  "-addext", "subjectAltName=IP:127.0.0.1",
  "-days", "1",
], { stdio: "ignore" });

execFileSync(process.execPath, ["../../node_modules/next/dist/bin/next", "build"], {
  cwd: new URL("../../apps/web", import.meta.url),
  env: process.env,
  stdio: "inherit",
});

const webRoot = new URL("../../apps/web/", import.meta.url);
const standaloneRoot = new URL(".next/standalone/apps/web/", webRoot);
const publicRoot = new URL("public/", webRoot);
if (existsSync(publicRoot)) {
  cpSync(publicRoot, new URL("public/", standaloneRoot), { recursive: true });
}
cpSync(new URL(".next/static/", webRoot), new URL(".next/static/", standaloneRoot), { recursive: true });
const child = spawn(process.execPath, ["server.js"], {
  cwd: standaloneRoot,
  env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: "3201" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const proxy = createHttpsServer({
  cert: readFileSync(certificate),
  key: readFileSync(key),
}, (request, response) => {
  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port: 3201,
    method: request.method,
    path: request.url,
    headers: {
      ...request.headers,
      host: "127.0.0.1:3200",
      // Vercel overwrites this platform marker before the application runs.
      // The local TLS proxy does the same so product code never trusts a
      // browser-supplied forwarding header in this production-mode journey.
      "x-vercel-id": "iad1::production-browser-fixture",
      "x-forwarded-host": "127.0.0.1:3200",
      "x-forwarded-proto": "https",
    },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once("error", () => response.writeHead(502).end());
  request.pipe(upstream);
});

function waitForNext() {
  const probe = httpRequest({ hostname: "127.0.0.1", port: 3201, path: "/" }, (response) => {
    response.resume();
    proxy.listen(3200, "127.0.0.1");
  });
  probe.once("error", () => setTimeout(waitForNext, 25));
  probe.end();
}
waitForNext();

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  proxy.close();
  child.kill(signal);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("exit", (code, signal) => {
  rmSync(certificateRoot, { force: true, recursive: true });
  if (signal !== null) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
