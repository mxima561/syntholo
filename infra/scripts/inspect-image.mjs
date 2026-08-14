#!/usr/bin/env node
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { validateImageMetadata } from "./foundation-gate-lib.mjs";

const execFileAsync = promisify(execFile);
const [image, service, releaseSha, outputPath] = process.argv.slice(2);
if (
  image === undefined
  || !["api", "cron", "migrate", "worker"].includes(service)
  || releaseSha === undefined
  || outputPath === undefined
) throw new Error("IMAGE_INSPECTION_INPUT_INVALID");

const [{ stdout: inspectOutput }, { stdout: historyOutput }, { stdout: filesOutput }] =
  await Promise.all([
    execFileAsync("docker", ["image", "inspect", image]),
    execFileAsync("docker", ["history", "--no-trunc", "--format", "{{.CreatedBy}}", image]),
    execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "/usr/bin/find",
      image,
      "/app",
      "-type",
      "f",
      "-print",
    ]),
  ]);
const inspected = JSON.parse(inspectOutput)[0];
const metadata = {
  command: inspected?.Config?.Cmd ?? [],
  entrypoint: inspected?.Config?.Entrypoint ?? [],
  files: filesOutput.trim().split("\n").filter(Boolean),
  history: historyOutput.trim().split("\n").filter(Boolean),
  labels: inspected?.Config?.Labels ?? {},
  releaseSha,
  service,
  user: inspected?.Config?.User ?? "",
};
const result = validateImageMetadata(metadata);
await writeFile(outputPath, `${JSON.stringify({ metadata, result })}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== "PASS") process.exitCode = 1;
