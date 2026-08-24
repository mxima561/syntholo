import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function applyEnvFile(envPath: string) {
  if (!existsSync(envPath)) return false;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

export function loadRootEnv() {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../.env"),
    path.resolve(process.cwd(), "../../.env"),
  ];
  if (typeof import.meta.dirname === "string") {
    candidates.push(path.resolve(import.meta.dirname, "../../../.env"));
  }
  for (const envPath of candidates) {
    if (applyEnvFile(envPath)) return;
  }
}
