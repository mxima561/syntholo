import { z } from "zod";

const BlockIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const encodedSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const TitleSchema = z.string().trim().min(1).max(255);
const HttpsUrlSchema = z.string().url().max(2_048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "HTTPS URL required");

const TextMarkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }).strict(),
  z.object({ type: z.literal("italic") }).strict(),
  z.object({ type: z.literal("code") }).strict(),
  z.object({ type: z.literal("link"), href: HttpsUrlSchema }).strict(),
]);
const TextNodeSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(20_000),
  marks: z.array(TextMarkSchema).max(4).optional(),
}).strict().superRefine((node, context) => {
  const markTypes = node.marks?.map(({ type }) => type) ?? [];
  if (new Set(markTypes).size !== markTypes.length) {
    context.addIssue({ code: "custom", message: "Duplicate text mark" });
  }
});
const HardBreakNodeSchema = z.object({ type: z.literal("hard_break") }).strict();
const InlineNodeSchema = z.discriminatedUnion("type", [TextNodeSchema, HardBreakNodeSchema]);
const ParagraphNodeSchema = z.object({
  type: z.literal("paragraph"), content: z.array(InlineNodeSchema).max(500),
}).strict();
const HeadingNodeSchema = z.object({
  type: z.literal("heading"), level: z.union([z.literal(2), z.literal(3)]),
  content: z.array(InlineNodeSchema).min(1).max(100),
}).strict();
const BlockquoteNodeSchema = z.object({
  type: z.literal("blockquote"), content: z.array(ParagraphNodeSchema).min(1).max(100),
}).strict();
const ListItemNodeSchema = z.object({
  type: z.literal("list_item"),
  content: z.array(z.union([ParagraphNodeSchema, BlockquoteNodeSchema])).min(1).max(100),
}).strict();
const BulletListNodeSchema = z.object({
  type: z.literal("bullet_list"), content: z.array(ListItemNodeSchema).min(1).max(200),
}).strict();
const OrderedListNodeSchema = z.object({
  type: z.literal("ordered_list"), start: z.number().int().min(1).max(10_000).optional(),
  content: z.array(ListItemNodeSchema).min(1).max(200),
}).strict();
const CodeBlockNodeSchema = z.object({
  type: z.literal("code_block"),
  language: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_+-]+$/u).optional(),
  text: z.string().min(1).max(20_000),
}).strict();
const StructuredTextBlockNodeSchema = z.discriminatedUnion("type", [
  ParagraphNodeSchema, HeadingNodeSchema, BlockquoteNodeSchema,
  BulletListNodeSchema, OrderedListNodeSchema, CodeBlockNodeSchema,
]);
export const StructuredTextDocumentSchema = z.object({
  type: z.literal("doc"), content: z.array(StructuredTextBlockNodeSchema).max(500),
}).strict().refine((value) => encodedSize(value) <= 65_536, "Document is too large");
const BoundedDocumentSchema = StructuredTextDocumentSchema;

const RichTextBlockSchema = z.object({
  type: z.literal("rich_text"), blockId: BlockIdSchema, document: BoundedDocumentSchema,
}).strict();
const CalloutBlockSchema = z.object({
  type: z.literal("callout"), blockId: BlockIdSchema,
  tone: z.enum(["info", "warning"]), document: BoundedDocumentSchema,
}).strict();
const ChecklistBlockSchema = z.object({
  type: z.literal("checklist"), blockId: BlockIdSchema, title: TitleSchema,
  items: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
}).strict();
const ActionBlockSchema = z.object({
  type: z.literal("action"), blockId: BlockIdSchema, title: TitleSchema,
  instructions: z.string().trim().min(1).max(10_000), outputKind: z.string().trim().min(1).max(64).optional(),
}).strict();
const ResourceListBlockSchema = z.object({
  type: z.literal("resource_list"), blockId: BlockIdSchema,
  resourceIds: z.array(z.string().uuid()).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.resourceIds).size !== value.resourceIds.length) {
    context.addIssue({ code: "custom", message: "Duplicate resource ID" });
  }
});
const RecommendationBlockSchema = z.object({
  type: z.literal("recommendation"), blockId: BlockIdSchema, title: TitleSchema,
  rationale: z.string().trim().min(1).max(5_000), externalHttpsUrl: HttpsUrlSchema.optional(),
}).strict();
const DisclosureBlockSchema = z.object({
  type: z.literal("disclosure"), blockId: BlockIdSchema,
  disclosureKind: z.string().trim().min(1).max(64),
  policyVersion: z.string().trim().min(1).max(64), document: BoundedDocumentSchema,
}).strict();
const VideoBlockSchema = z.object({
  type: z.literal("video"), blockId: BlockIdSchema, mediaAssetId: z.string().uuid(),
}).strict();

export const LessonBlockSchema = z.discriminatedUnion("type", [
  RichTextBlockSchema, CalloutBlockSchema, ChecklistBlockSchema,
  ActionBlockSchema, ResourceListBlockSchema, RecommendationBlockSchema,
  DisclosureBlockSchema, VideoBlockSchema,
]);

export const LessonBlocksSchema = z.array(LessonBlockSchema).max(100).superRefine((blocks, context) => {
  const ids = new Set<string>();
  let videos = 0;
  for (const block of blocks) {
    if (ids.has(block.blockId)) context.addIssue({ code: "custom", message: "Duplicate block ID" });
    ids.add(block.blockId);
    if (block.type === "video") videos += 1;
  }
  if (videos > 1) context.addIssue({ code: "custom", message: "Only one primary video is allowed" });
  if (encodedSize(blocks) > 262_144) {
    context.addIssue({ code: "custom", message: "Lesson blocks are too large" });
  }
});

export const TranscriptSchema = z.object({
  schemaVersion: z.literal(1),
  blocks: z.array(z.object({
    blockId: BlockIdSchema,
    text: z.string().trim().min(1).max(20_000),
  }).strict()).max(1_000),
}).strict().superRefine((transcript, context) => {
  const ids = transcript.blocks.map(({ blockId }) => blockId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Duplicate transcript block ID" });
  if (encodedSize(transcript) > 1_048_576) {
    context.addIssue({ code: "custom", message: "Transcript is too large" });
  }
});

export const ReleaseRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("immediate") }).strict(),
  z.object({ kind: z.literal("elapsed_days"), days: z.number().int().min(0).max(365) }).strict(),
  z.object({ kind: z.literal("fixed_at"), at: z.string().datetime({ offset: false, local: false, precision: 3 }) }).strict(),
]);

export type LessonBlock = z.infer<typeof LessonBlockSchema>;
export type ReleaseRule = z.infer<typeof ReleaseRuleSchema>;
export type StructuredTextDocument = z.infer<typeof StructuredTextDocumentSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
