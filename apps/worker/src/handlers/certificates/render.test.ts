import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function loadRenderer() {
  return import("./render.js").catch(() => null);
}

const input = {
  recipientName: "Zoë 李",
  businessName: "Syntholo Studio",
  courseTitle: "AI Systems Academy",
  courseVersion: 3,
  completedAt: "2026-08-15T12:00:00.000Z",
} as const;

describe("certificate PDF renderer", () => {
  it("renders byte-identical Unicode PDFs from exact frozen inputs", async () => {
    const renderer = await loadRenderer();
    expect(renderer, "certificate renderer must exist").not.toBeNull();
    if (renderer === null) return;

    await expect(renderer.assertCertificateRendererReadiness()).resolves.toBeUndefined();
    await expect(renderer.assertCertificateRendererReadiness()).resolves.toBeUndefined();

    const first = await renderer.renderCertificatePdf(input);
    const second = await renderer.renderCertificatePdf(input);
    expect(first).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(first).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(Buffer.from(second)).toEqual(Buffer.from(first));
    expect(first.byteLength).toBe(5_821);
    expect(createHash("sha256").update(first).digest("hex"))
      .toBe("c3d54eec60d4b0bd0dfc29a8ded942582aa3fb2d5c7801ef27eab29989ca149e");
    const parsed = await PDFDocument.load(first, { updateMetadata: false });
    expect(parsed.getTitle()).toBe("Syntholo — Unaccredited certificate of completion");
    expect(parsed.getSubject()).toBe("Unaccredited certificate of completion");
    expect(parsed.getAuthor()).toBe("Syntholo");
    expect(parsed.getCreator()).toBe("Syntholo");
    expect(parsed.getProducer()).toBe("Syntholo");
    expect(parsed.getCreationDate()?.toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(parsed.getModificationDate()?.toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(parsed.getPages()).toHaveLength(1);
    expect(parsed.getPages()[0]?.getSize()).toEqual({ width: 792, height: 612 });
  });

  it("freezes the only approved certificate copy", async () => {
    const renderer = await loadRenderer();
    expect(renderer).not.toBeNull();
    if (renderer === null) return;

    expect(renderer.certificateApprovedCopy(input)).toEqual([
      "Syntholo",
      "Unaccredited certificate of completion",
      "Zoë 李",
      "AI Systems Academy",
      "Syntholo Studio",
      "Course version 3",
      "Completed 2026-08-15 UTC",
    ]);
    for (const forbidden of [
      "verified",
      "certified",
      "certificate id",
      "certificate number",
      "score",
      "grade",
      "support tier",
      "implementation",
      "http://",
      "https://",
    ]) {
      expect(renderer.certificateApprovedCopy(input).join("\n").toLowerCase())
        .not.toContain(forbidden);
    }
    expect(renderer.certificateApprovedCopy(input).join("\n").toLowerCase())
      .not.toMatch(/\baccredited\b/u);
  });

  it("rejects unknown copy fields and noncanonical recipient snapshots", async () => {
    const renderer = await loadRenderer();
    expect(renderer).not.toBeNull();
    if (renderer === null) return;

    await expect(renderer.renderCertificatePdf({
      ...input,
      certificateNumber: "CERT-001",
    })).rejects.toThrow("CERTIFICATE_RENDER_INPUT_INVALID");
    await expect(renderer.renderCertificatePdf({
      ...input,
      recipientName: " Zoe\u0308  李 ",
    })).rejects.toThrow("CERTIFICATE_RENDER_INPUT_INVALID");
    await expect(renderer.renderCertificatePdf({
      ...input,
      completedAt: "2026-08-15T12:00:00Z",
    })).rejects.toThrow("CERTIFICATE_RENDER_INPUT_INVALID");
    await expect(renderer.renderCertificatePdf({ ...input, completedAt: "2026-08-15T12:00:00.001Z" }))
      .resolves.toBeInstanceOf(Uint8Array);
    await expect(renderer.renderCertificatePdf({ ...input, courseTitle: "Unsupported \ue000 title" }))
      .rejects.toThrow("CERTIFICATE_RENDER_INPUT_INVALID");
    await expect(renderer.renderCertificatePdf({ ...input, businessName: "Unsupported \ue000 business" }))
      .rejects.toThrow("CERTIFICATE_RENDER_INPUT_INVALID");
    for (const courseTitle of ["Line\nBreak", "Bidi\u202Eoverride", "Noncharacter\ufdd0"]) {
      await expect(renderer.renderCertificatePdf({ ...input, courseTitle }))
        .rejects.toThrow("CERTIFICATE_RENDER_INPUT_INVALID");
    }
    await expect(renderer.renderCertificatePdf({ ...input, courseTitle: "😀".repeat(255) }))
      .resolves.toBeInstanceOf(Uint8Array);
  });

  it("pins the exact licensed Unicode font and its attribution", async () => {
    const font = await readFile(new URL("./assets/unifont-15.0.04.ttf", import.meta.url));
    const upper = await readFile(new URL("./assets/unifont_upper-15.0.04.ttf", import.meta.url));
    const license = await readFile(new URL("./assets/OFL.txt", import.meta.url));
    const attribution = await readFile(new URL("./assets/ATTRIBUTION.md", import.meta.url));
    const manifest = JSON.parse(await readFile(
      new URL("./assets/certificate-font-repertoire.v1.json", import.meta.url),
      "utf8",
    )) as { manifestCanonicalSha256?: unknown };
    expect(createHash("sha256").update(font).digest("hex"))
      .toBe("92449b12f581aef7270601c374a263a52605e812431309984b15506cf910eaca");
    expect(createHash("sha256").update(upper).digest("hex"))
      .toBe("ee245cc8a7c6a6fdab8d52cf44d721c695f08f4280e639600e709f1bb6f22cb2");
    expect(createHash("sha256").update(license).digest("hex"))
      .toBe("6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2");
    expect(createHash("sha256").update(attribution).digest("hex"))
      .toBe("8ca6820359941fd2d18754206fb4945500fba41d15b669ba59548b81049c38f0");
    expect(manifest.manifestCanonicalSha256)
      .toBe("08b07f94c69e07cf51395aaa8057a4f5c2aebd1571fcf50e32baa89e9c881f96");
    expect(license.toString("utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    const check = await execFileAsync(process.execPath, [
      new URL("../../../scripts/generate-certificate-font-repertoire.mjs", import.meta.url).pathname,
      "--check",
    ]);
    expect(check.stdout.trim()).toBe("certificate font repertoire check passed");
  });

  it("renders representative BMP and astral name scripts with nonzero glyphs", async () => {
    const renderer = await loadRenderer();
    expect(renderer).not.toBeNull();
    if (renderer === null) return;
    for (const recipientName of ["ليلى", "आशा", "שירה", "Zoë 李", "𐐀𐐨𐑅"]) {
      await expect(renderer.renderCertificatePdf({ ...input, recipientName }))
        .resolves.toBeInstanceOf(Uint8Array);
    }
  });

  it("fits maximum valid recipient and snapshot strings inside the certificate frame", async () => {
    const renderer = await loadRenderer();
    expect(renderer).not.toBeNull();
    if (renderer === null) return;
    for (const recipientName of ["𐐀".repeat(120), "😀".repeat(120), "李".repeat(120)]) {
      const maximum = {
        ...input,
        recipientName,
        businessName: "W".repeat(255),
        courseTitle: "M".repeat(255),
      };
      const layout = await renderer.layoutCertificateCopy(maximum);
      expect(layout.length).toBeGreaterThan(7);
      for (const line of layout) {
        expect(line.x).toBeGreaterThanOrEqual(68);
        expect(line.x + line.width).toBeLessThanOrEqual(724);
        expect(line.y).toBeGreaterThanOrEqual(68);
        expect(line.y).toBeLessThanOrEqual(544);
        expect(line.size).toBeGreaterThanOrEqual(5);
      }
      await expect(renderer.renderCertificatePdf(maximum)).resolves.toBeInstanceOf(Uint8Array);
    }
  });
});
