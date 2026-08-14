#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const forbiddenValues = [
  "postgres://",
  "member_runtime",
  "staff_runtime",
  "worker_runtime",
  "sk_test",
  "pk_test",
  "client_test",
  "org_test",
  "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU",
];

const requiredServices = ["api", "cron", "migrate", "worker"];
const logPaths = new Map(requiredServices.map((service) => [service, []]));
for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf("=");
  const service = argument.slice(0, separator);
  const path = argument.slice(separator + 1);
  if (separator < 1 || path === "" || !logPaths.has(service)) {
    throw new Error("SECRET_FREE_LOG_COVERAGE_INVALID");
  }
  logPaths.get(service).push(path);
}
if ([...logPaths.values()].some((paths) => paths.length === 0)) {
  throw new Error("SECRET_FREE_LOG_COVERAGE_INVALID");
}

for (const path of [...logPaths.values()].flat()) {
  const contents = await readFile(path, "utf8");
  if (forbiddenValues.some((value) => contents.includes(value))) {
    throw new Error("STARTUP_LOG_SECRET_EXPOSURE");
  }
}
