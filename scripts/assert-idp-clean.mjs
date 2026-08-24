import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const needle = ["work", "os"].join("");
const result = spawnSync(
  "rg",
  [
    "-i",
    needle,
    "--glob",
    "!CHANGELOG.md",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!.next/**",
    "--glob",
    "!package-lock.json",
    "--glob",
    "!graphify-out/**",
    "--glob",
    "!.env",
    "--glob",
    "!.env.*",
    "--glob",
    "!.worktrees/**",
    "--glob",
    "!.superpowers/**",
  ],
  { encoding: "utf8", cwd: root },
);

if (result.status === 0 && result.stdout.trim()) {
  console.error(result.stdout);
  process.exit(1);
}

if (result.status === 1) {
  console.log("Legacy IdP references are confined to CHANGELOG.md");
  process.exit(0);
}

console.error(result.stderr || "search failed");
process.exit(result.status ?? 1);
