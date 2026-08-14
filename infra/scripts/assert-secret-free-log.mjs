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

for (const path of process.argv.slice(2)) {
  const contents = await readFile(path, "utf8");
  if (forbiddenValues.some((value) => contents.includes(value))) {
    throw new Error("STARTUP_LOG_SECRET_EXPOSURE");
  }
}
