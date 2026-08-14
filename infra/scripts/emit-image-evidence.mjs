#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const releaseSha = process.env.RELEASE_SHA?.trim();
if (!/^[0-9a-f]{40}$/u.test(releaseSha ?? "")) {
  throw new Error("IMAGE_EVIDENCE_RELEASE_INVALID");
}

const evidenceFiles = process.argv.slice(2);
if (evidenceFiles.length === 0) throw new Error("IMAGE_EVIDENCE_FILES_REQUIRED");
const hash = createHash("sha256");
for (const path of [...evidenceFiles].sort()) {
  hash.update(path);
  hash.update(await readFile(path));
}

await writeFile("image-evidence.json", `${JSON.stringify({
  artifactHash: hash.digest("hex"),
  createdAt: new Date().toISOString(),
  environment: "ci",
  releaseSha,
  services: ["api", "cron", "migrate", "worker"],
  status: "PASS",
  type: "images",
  version: 1,
})}\n`, "utf8");
