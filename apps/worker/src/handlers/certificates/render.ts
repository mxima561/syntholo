import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import {
  CERTIFICATE_FONT_REPERTOIRE,
  certificateBusinessNameRenderable,
  certificateCourseTitleRenderable,
  canonicalizeCertificateRecipientName,
} from "@syntholo/domain/certificates";
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { z } from "zod";

const fixedMetadataDate = new Date("2000-01-01T00:00:00.000Z");
const assetsUrl = new URL("./assets/", import.meta.url);
const readinessInput = Object.freeze({
  recipientName: "Zoë 李",
  businessName: "Syntholo Studio",
  courseTitle: "AI Systems Academy",
  courseVersion: 3,
  completedAt: "2026-08-15T12:00:00.000Z",
});
const readinessPdfByteLength = 5_821;
const readinessPdfSha256 = "c3d54eec60d4b0bd0dfc29a8ded942582aa3fb2d5c7801ef27eab29989ca149e";

type CertificateAuthorityAssets = Readonly<{
  basic: Uint8Array;
  upper: Uint8Array;
}>;
let authorityAssetsPromise: Promise<CertificateAuthorityAssets> | undefined;
let rendererReadinessPromise: Promise<void> | undefined;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadCertificateAuthorityAssets(): Promise<CertificateAuthorityAssets> {
  if (authorityAssetsPromise !== undefined) return authorityAssetsPromise;
  const pending = (async () => {
    const [basic, upper, license, attribution, manifestBytes] = await Promise.all([
      readFile(new URL("unifont-15.0.04.ttf", assetsUrl)),
      readFile(new URL("unifont_upper-15.0.04.ttf", assetsUrl)),
      readFile(new URL("OFL.txt", assetsUrl)),
      readFile(new URL("ATTRIBUTION.md", assetsUrl)),
      readFile(new URL("certificate-font-repertoire.v1.json", assetsUrl)),
    ]);
    if (sha256(basic) !== CERTIFICATE_FONT_REPERTOIRE.fonts[0]!.sha256
      || sha256(upper) !== CERTIFICATE_FONT_REPERTOIRE.fonts[1]!.sha256
      || sha256(license) !== CERTIFICATE_FONT_REPERTOIRE.license.sha256
      || sha256(attribution) !== CERTIFICATE_FONT_REPERTOIRE.attribution.sha256) {
      throw new Error("CERTIFICATE_RENDER_FONT_AUTHORITY_INVALID");
    }
    try {
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
      if (JSON.stringify(manifest) !== JSON.stringify(CERTIFICATE_FONT_REPERTOIRE)) {
        throw new Error("CERTIFICATE_RENDER_FONT_AUTHORITY_INVALID");
      }
      const { manifestCanonicalSha256, ...authority } = manifest;
      if (manifestCanonicalSha256 !== CERTIFICATE_FONT_REPERTOIRE.manifestCanonicalSha256
        || sha256(canonicalJson(authority)) !== manifestCanonicalSha256) {
        throw new Error("CERTIFICATE_RENDER_FONT_AUTHORITY_INVALID");
      }
    } catch {
      throw new Error("CERTIFICATE_RENDER_FONT_AUTHORITY_INVALID");
    }
    return Object.freeze({ basic, upper });
  })();
  authorityAssetsPromise = pending.catch(() => {
    authorityAssetsPromise = undefined;
    throw new Error("CERTIFICATE_RENDER_FONT_AUTHORITY_INVALID");
  });
  return authorityAssetsPromise;
}

const CertificateRenderInputSchema = z.object({
  recipientName: z.string().refine((value) => {
    try {
      return canonicalizeCertificateRecipientName(value) === value;
    } catch {
      return false;
    }
  }),
  businessName: z.string().refine(certificateBusinessNameRenderable),
  courseTitle: z.string().refine(certificateCourseTitleRenderable),
  courseVersion: z.number().int().positive().max(2_147_483_647),
  completedAt: z.string().datetime({ offset: false, precision: 3 }),
}).strict();

export type CertificateRenderInput = z.infer<typeof CertificateRenderInputSchema>;

function parseInput(input: unknown): CertificateRenderInput {
  const parsed = CertificateRenderInputSchema.safeParse(input);
  if (!parsed.success) throw new Error("CERTIFICATE_RENDER_INPUT_INVALID");
  return parsed.data;
}

export function certificateApprovedCopy(input: unknown): readonly string[] {
  const fact = parseInput(input);
  return Object.freeze([
    "Syntholo",
    "Unaccredited certificate of completion",
    fact.recipientName,
    fact.courseTitle,
    fact.businessName,
    `Course version ${fact.courseVersion}`,
    `Completed ${fact.completedAt.slice(0, 10)} UTC`,
  ]);
}

function drawUnicodeLine(input: Readonly<{
  page: PDFPage;
  text: string;
  x: number;
  y: number;
  size: number;
  color: RGB;
  basic: PDFFont;
  upper: PDFFont;
}>): void {
  const basicCharacters = new Set(input.basic.getCharacterSet());
  const upperCharacters = new Set(input.upper.getCharacterSet());
  const runs: Array<{ font: PDFFont; text: string }> = [];
  for (const scalar of input.text) {
    const codePoint = scalar.codePointAt(0)!;
    const font = basicCharacters.has(codePoint)
      ? input.basic
      : upperCharacters.has(codePoint)
        ? input.upper
        : null;
    if (font === null) throw new Error("CERTIFICATE_RENDER_GLYPH_UNAVAILABLE");
    const last = runs.at(-1);
    if (last?.font === font) last.text += scalar;
    else runs.push({ font, text: scalar });
  }
  let x = input.x;
  for (const run of runs) {
    input.page.drawText(run.text, { x, y: input.y, size: input.size, font: run.font, color: input.color });
    x += run.font.widthOfTextAtSize(run.text, input.size);
  }
}

type EmbeddedFonts = Readonly<{ basic: PDFFont; upper: PDFFont }>;
export type CertificateLayoutLine = Readonly<{
  text: string;
  x: number;
  y: number;
  size: number;
  width: number;
}>;

function authoritativeFont(codePoint: number, fonts: EmbeddedFonts): PDFFont {
  if (fonts.basic.getCharacterSet().includes(codePoint)) return fonts.basic;
  if (fonts.upper.getCharacterSet().includes(codePoint)) return fonts.upper;
  throw new Error("CERTIFICATE_RENDER_GLYPH_UNAVAILABLE");
}

function textWidthAtUnit(text: string, fonts: EmbeddedFonts): number {
  let width = 0;
  let run = "";
  let runFont: PDFFont | null = null;
  for (const scalar of text) {
    const font = authoritativeFont(scalar.codePointAt(0)!, fonts);
    if (runFont !== null && runFont !== font) {
      width += runFont.widthOfTextAtSize(run, 1);
      run = "";
    }
    runFont = font;
    run += scalar;
  }
  return width + (runFont?.widthOfTextAtSize(run, 1) ?? 0);
}

function textSegments(text: string): string[] {
  const segments: string[] = [];
  for (const scalar of text) {
    if (/^\p{M}$/u.test(scalar) && segments.length > 0) segments[segments.length - 1] += scalar;
    else segments.push(scalar);
  }
  return segments;
}

function fitText(input: Readonly<{
  text: string;
  x: number;
  y: number;
  maxWidth: number;
  maxSize: number;
  maxLines: number;
  fonts: EmbeddedFonts;
}>): CertificateLayoutLine[] {
  const segments = textSegments(input.text);
  const totalWidth = textWidthAtUnit(input.text, input.fonts);
  const targetWidth = Math.max(totalWidth / input.maxLines, input.maxWidth / input.maxSize);
  const lines: string[] = [];
  let current = "";
  for (const segment of segments) {
    const candidate = current + segment;
    if (current !== "" && textWidthAtUnit(candidate, input.fonts) > targetWidth
      && lines.length < input.maxLines - 1) {
      lines.push(current);
      current = segment;
    } else current = candidate;
  }
  if (current !== "") lines.push(current);
  const widest = Math.max(...lines.map((line) => textWidthAtUnit(line, input.fonts)));
  const size = Math.min(input.maxSize, input.maxWidth / widest);
  return lines.map((line, index) => Object.freeze({
    text: line,
    x: input.x,
    y: input.y - index * size * 1.25,
    size,
    width: textWidthAtUnit(line, input.fonts) * size,
  }));
}

async function embedCertificateFonts(document: PDFDocument): Promise<EmbeddedFonts> {
  const assets = await loadCertificateAuthorityAssets();
  return Object.freeze({
    basic: await document.embedFont(assets.basic, { subset: true }),
    upper: await document.embedFont(assets.upper, { subset: true }),
  });
}

function layoutCopy(copy: readonly string[], fonts: EmbeddedFonts): CertificateLayoutLine[] {
  const inputs = [
    { text: copy[0]!, y: 518, maxSize: 18, maxLines: 1 },
    { text: copy[1]!, y: 448, maxSize: 24, maxLines: 1 },
    { text: copy[2]!, y: 350, maxSize: 30, maxLines: 2 },
    { text: copy[3]!, y: 288, maxSize: 16, maxLines: 2 },
    { text: copy[4]!, y: 230, maxSize: 14, maxLines: 2 },
    { text: copy[5]!, y: 168, maxSize: 12, maxLines: 1 },
    { text: copy[6]!, y: 140, maxSize: 12, maxLines: 1 },
  ];
  return inputs.flatMap((line) => fitText({ ...line, x: 68, maxWidth: 656, fonts }));
}

export async function layoutCertificateCopy(input: unknown): Promise<readonly CertificateLayoutLine[]> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.registerFontkit(fontkit);
  const fonts = await embedCertificateFonts(document);
  return Object.freeze(layoutCopy(certificateApprovedCopy(input), fonts));
}

export async function renderCertificatePdf(input: unknown): Promise<Uint8Array> {
  const copy = certificateApprovedCopy(input);
  const document = await PDFDocument.create({ updateMetadata: false });
  document.registerFontkit(fontkit);
  document.setTitle("Syntholo — Unaccredited certificate of completion");
  document.setSubject("Unaccredited certificate of completion");
  document.setAuthor("Syntholo");
  document.setCreator("Syntholo");
  document.setProducer("Syntholo");
  document.setCreationDate(fixedMetadataDate);
  document.setModificationDate(fixedMetadataDate);
  const fonts = await embedCertificateFonts(document);
  const page = document.addPage([792, 612]);
  page.drawRectangle({ x: 34, y: 34, width: 724, height: 544, borderColor: rgb(0.08, 0.16, 0.22), borderWidth: 2 });
  const lines = layoutCopy(copy, fonts);
  for (const line of lines) {
    const color = line.y >= 400 ? rgb(0.08, 0.16, 0.22)
      : line.y >= 300 ? rgb(0.06, 0.10, 0.14)
        : rgb(0.12, 0.18, 0.22);
    drawUnicodeLine({ page, basic: fonts.basic, upper: fonts.upper, color, ...line });
  }
  return document.save({
    addDefaultPage: false,
    objectsPerTick: Number.POSITIVE_INFINITY,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

export async function assertCertificateRendererReadiness(): Promise<void> {
  if (rendererReadinessPromise !== undefined) return rendererReadinessPromise;
  const pending = (async () => {
    await loadCertificateAuthorityAssets();
    const pdf = await renderCertificatePdf(readinessInput);
    if (pdf.byteLength !== readinessPdfByteLength || sha256(pdf) !== readinessPdfSha256) {
      throw new Error("CERTIFICATE_RENDER_FONT_AUTHORITY_INVALID");
    }
  })();
  rendererReadinessPromise = pending.catch((error: unknown) => {
    rendererReadinessPromise = undefined;
    throw error;
  });
  return rendererReadinessPromise;
}
