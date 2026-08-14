import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const demoMarkers = [
  "Maria Chen",
  "Northstar Advisory",
  "Naomi Reed",
  "member-maria",
  "demoReferenceTime",
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }))).flat();
}

test("production learn payloads and client-reference chunks contain no demo member data", async () => {
  const buildDirectory = resolve(process.env.WEB_BUILD_DIR ?? ".next");
  const routeDirectory = resolve(buildDirectory, "server/app/learn");
  const routeFiles = await filesBelow(routeDirectory);
  const routeArtifacts = routeFiles.filter((path) =>
    /\.(?:html|rsc)$/u.test(path));
  const clientReferences = routeFiles.filter((path) =>
    /_client-reference-manifest\.js$/u.test(path));
  assert.ok(routeArtifacts.length > 0, "production /learn artifacts are required");
  assert.ok(clientReferences.length > 0, "production /learn client references are required");

  const payloads = await Promise.all(routeArtifacts.map(async (path) => ({
    path,
    text: await readFile(path, "utf8"),
  })));
  const manifests = await Promise.all(clientReferences.map(async (path) => ({
    path,
    text: await readFile(path, "utf8"),
  })));
  const referencedChunks = new Set();
  for (const { text } of [...payloads, ...manifests]) {
    for (const match of text.matchAll(/(?:\/_next\/)?static\/chunks\/([^"?]+\.js)/gu)) {
      referencedChunks.add(resolve(buildDirectory, "static/chunks", match[1]));
    }
  }
  assert.ok(referencedChunks.size > 0, "production /learn browser chunks are required");

  const publicArtifacts = [
    ...payloads,
    ...await Promise.all([...referencedChunks].map(async (path) => ({
      path,
      text: await readFile(path, "utf8"),
    }))),
  ];
  for (const { path, text } of publicArtifacts) {
    for (const marker of demoMarkers) {
      assert.equal(text.includes(marker), false, `${marker} leaked through ${path}`);
    }
  }
});
