#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import fontkit from "@pdf-lib/fontkit";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const assetRoot = resolve(repositoryRoot, "apps/worker/src/handlers/certificates/assets");
const output = resolve(
  repositoryRoot,
  "packages/contracts/src/learning/certificate-font-repertoire.v1.json",
);
const domainOutput = resolve(
  repositoryRoot,
  "packages/domain/src/certificates/certificate-font-repertoire.v1.json",
);
const assetOutput = resolve(assetRoot, "certificate-font-repertoire.v1.json");
const fontNames = ["unifont-15.0.04.ttf", "unifont_upper-15.0.04.ttf"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const fontBytes = await Promise.all(fontNames.map((name) => readFile(resolve(assetRoot, name))));
const fonts = fontBytes.map((bytes, index) => fontkit.create(bytes));
const codePoints = [...new Set(fonts.flatMap((font) =>
  font.characterSet.filter((codePoint) => font.glyphForCodePoint(codePoint).id !== 0)))]
  .sort((left, right) => left - right);
const supportedCodePointRanges = [];
let start = codePoints[0];
let previous = start;
for (const codePoint of codePoints.slice(1)) {
  if (codePoint === previous + 1) {
    previous = codePoint;
    continue;
  }
  supportedCodePointRanges.push([start, previous]);
  start = codePoint;
  previous = codePoint;
}
supportedCodePointRanges.push([start, previous]);
const license = await readFile(resolve(assetRoot, "OFL.txt"));
const attribution = await readFile(resolve(assetRoot, "ATTRIBUTION.md"));
const authority = {
  schemaVersion: 1,
  algorithm: "certificate-font-repertoire.v1",
  fonts: fontNames.map((name, index) => ({ name, sha256: sha256(fontBytes[index]) })),
  license: { name: "OFL.txt", sha256: sha256(license) },
  attribution: { name: "ATTRIBUTION.md", sha256: sha256(attribution) },
  supportedScalarCount: codePoints.length,
  supportedCodePointRanges,
};
const manifest = {
  ...authority,
  manifestCanonicalSha256: sha256(canonicalJson(authority)),
};
const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.slice(2).includes("--check")) {
  const existing = await Promise.all([
    readFile(output, "utf8"),
    readFile(domainOutput, "utf8"),
    readFile(assetOutput, "utf8"),
  ]);
  if (existing.some((value) => value !== serializedManifest)) {
    throw new Error("CERTIFICATE_FONT_REPERTOIRE_DRIFT");
  }
  process.stdout.write("certificate font repertoire check passed\n");
} else {
  await writeFile(output, serializedManifest, "utf8");
  await writeFile(domainOutput, serializedManifest, "utf8");
  await writeFile(assetOutput, serializedManifest, "utf8");
}
