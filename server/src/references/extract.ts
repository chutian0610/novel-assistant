import { resolveRoute } from '../llm/resolver';
import { RouteNotConfiguredError } from '../llm/routed';
import { LLMError, type ChatRequest, type LLMProvider } from '../llm/types';
import { MATERIAL_TYPES, PAYLOAD_FIELDS, type MaterialPayload, type MaterialType } from '../materials/store';
import type { DB } from '../db/open';
import { insertExtractionItems, markChapterDone, pendingChapters, remainingChapterCount, type ChapterRecord } from './store';

/** 单章最多入队条数，约束异常 LLM 输出的规模 */
const MAX_ITEMS_PER_CHAPTER = 20;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 50_000;

const SYSTEM_PROMPT = `你是网文拆书助手，从给定章节中抽取四类素材：setting（设定卡：世界观/人物/物品/势力/地点）、trope（桥段：冲突模式与情节展开）、style（文风样本：场景描写与句式节奏）、skeleton（书骨骼：节奏曲线/卷纲结构/人物原型）。
只输出 JSON，不要输出任何其他文字。格式：
{"materials":[{"type":"setting","title":"素材标题","content":"素材正文","payload":{}}]}
payload 可用键：setting→category；trope→structure；style→rhythm；skeleton→pacingCurve/volumeStructure/archetypes。
章节中没有值得积累的内容时输出 {"materials":[]}。`;

export interface ExtractRunResult {
  processed: { chapterId: number; chapterTitle: string; itemCount: number }[];
  failed: { chapterId: number; chapterTitle: string; error: string }[];
  remaining: number;
}

/** LLM 抽取/仿写产出的通用条目形状 */
export interface ExtractedMaterial {
  type: MaterialType;
  title: string;
  content: string;
  payload: MaterialPayload;
}

/**
 * 逐章抽取：每章独立调用 extract 任务路由，成功即落盘（条目 + 章节标记 done），
 * 单章失败不影响其余章节——失败的章保持 pending，下次请求继续（断点续跑）。
 * 路由未配置时整体抛 RouteNotConfiguredError（由 API 层映射 409）。
 */
export async function runExtraction(
  db: DB,
  llm: LLMProvider,
  referenceId: number,
  options: { chapterIds?: number[]; limit?: number } = {}
): Promise<ExtractRunResult> {
  if (!resolveRoute(db, 'extract')) throw new RouteNotConfiguredError('extract');

  const limit = options.limit ?? 1;
  const chapters = pendingChapters(db, referenceId, options.chapterIds).slice(0, limit);
  const processed: ExtractRunResult['processed'] = [];
  const failed: ExtractRunResult['failed'] = [];

  for (const chapter of chapters) {
    try {
      const items = await extractChapter(llm, chapter.title, chapter.content);
      const run = db.transaction(() => {
        insertExtractionItems(
          db,
          referenceId,
          items.map((item) => ({ ...item, chapterId: chapter.id, sourceSkeletonId: null }))
        );
        markChapterDone(db, chapter.id);
      });
      run();
      processed.push({ chapterId: chapter.id, chapterTitle: chapter.title, itemCount: items.length });
    } catch (cause) {
      if (cause instanceof RouteNotConfiguredError) throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      failed.push({ chapterId: chapter.id, chapterTitle: chapter.title, error: message });
    }
  }

  return { processed, failed, remaining: remainingChapterCount(db, referenceId) };
}

// ---------- 全书骨骼提取（T5） ----------

/** 全书上下文规模上限：最多 60 章、每章取开头 400 字 */
const SKELETON_MAX_CHAPTERS = 60;
const SKELETON_CHAPTER_PREVIEW = 400;

const SKELETON_PROMPT = `你是网文结构分析师。根据参考书的章节标题与开头片段，提炼整本书的书骨骼：节奏曲线（pacingCurve）、卷纲结构（volumeStructure）、人物原型（archetypes），三个字段都不得为空。
只输出 JSON，不要输出任何其他文字。格式：
{"materials":[{"type":"skeleton","title":"一句话概括该书结构","content":"结构方法论描述","payload":{"pacingCurve":"...","volumeStructure":"...","archetypes":"..."}}]}`;

export type BookSkeletonDraft = ExtractedMaterial & { type: 'skeleton' };

/** 从全书章节（标题 + 开头片段）提取结构完整的书骨骼；产出缺任一必备键视为失败。
 * 超长书只注入前 N 章，prompt 中如实标注注入范围，避免上下文与「全书」表述不符。 */
export async function extractBookSkeleton(llm: LLMProvider, chapters: ChapterRecord[]): Promise<BookSkeletonDraft> {
  const digestChapters = chapters.slice(0, SKELETON_MAX_CHAPTERS);
  const digest = digestChapters
    .map((chapter) => `【${chapter.title}】\n${chapter.content.slice(0, SKELETON_CHAPTER_PREVIEW)}`)
    .join('\n\n');
  const scope =
    digestChapters.length === chapters.length ? `全书 ${chapters.length} 章` : `前 ${digestChapters.length} / 共 ${chapters.length} 章`;
  const request: ChatRequest = {
    messages: [
      { role: 'system', content: SKELETON_PROMPT },
      { role: 'user', content: `【章节一览（${scope}）】\n${digest}` },
    ],
    temperature: 0.2,
    maxTokens: 4096,
  };
  const result = await llm.complete('extract', request);
  const items = parseExtraction(result.content);
  const skeleton = items.find((item) => item.type === 'skeleton');
  if (!skeleton) throw new ExtractionParseError('LLM 响应中没有书骨骼条目');
  return { ...skeleton, type: 'skeleton' as const };
}

// ---------- 书骨骼一键仿写（T5） ----------

const ADAPT_PROMPT = `你是网文创意生成器。给定一份书骨骼（节奏曲线/卷纲结构/人物原型），生成一套全新原创的设定卡（世界观/人物/势力/地点/物品，payload.category 标注领域），共 4-8 条，其中人物卡至少 2 条。
铁律：只借鉴结构方法论，不得复述参考书原文段落；所有人名/势力名/地名/物品名必须重新命名，不得复用源材料中出现的任何专有名词。
只输出 JSON，不要输出任何其他文字。格式：
{"materials":[{"type":"setting","title":"全新名称","content":"设定描述","payload":{"category":"人物|势力|地点|物品|世界观"}}]}`;

export type AdaptedSetting = ExtractedMaterial & { type: 'setting' };

/** 基于源书骨骼生成全新设定卡（只保留 setting 条目，空产出视为失败） */
export async function adaptBookSkeleton(llm: LLMProvider, skeleton: BookSkeletonDraft): Promise<AdaptedSetting[]> {
  const request: ChatRequest = {
    messages: [
      { role: 'system', content: ADAPT_PROMPT },
      {
        role: 'user',
        content: `【源书骨骼】${skeleton.title}\n【结构方法论】\n${skeleton.content}\n【节奏曲线】${skeleton.payload.pacingCurve ?? ''}\n【卷纲结构】${skeleton.payload.volumeStructure ?? ''}\n【人物原型】${skeleton.payload.archetypes ?? ''}`,
      },
    ],
    temperature: 0.8,
    maxTokens: 4096,
  };
  const result = await llm.complete('outline', request);
  const items = parseExtraction(result.content)
    .filter((item): item is AdaptedSetting => item.type === 'setting')
    .slice(0, MAX_ITEMS_PER_CHAPTER);
  if (items.length === 0) throw new ExtractionParseError('仿写未产出任何设定条目');
  return items;
}

async function extractChapter(llm: LLMProvider, chapterTitle: string, content: string) {
  const request: ChatRequest = {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `【章节标题】${chapterTitle}\n【章节正文】\n${content}` },
    ],
    temperature: 0.2,
    maxTokens: 4096,
  };
  const result = await llm.complete('extract', request);
  return parseExtraction(result.content);
}

export class ExtractionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionParseError';
  }
}

/** 解析 LLM 响应：容忍代码围栏与前后杂讯；非法条目逐条丢弃，整体非 JSON 视为失败 */
export function parseExtraction(content: string): ExtractedMaterial[] {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new ExtractionParseError(`LLM 响应不是合法的抽取 JSON：${content.slice(0, 80)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new ExtractionParseError(`LLM 响应不是合法的抽取 JSON：${content.slice(0, 80)}`);
  }
  const materials =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { materials?: unknown }).materials)
      ? ((parsed as { materials: unknown[] }).materials)
      : null;
  if (!materials) throw new ExtractionParseError('LLM 响应缺少 materials 数组');

  const items: { type: MaterialType; title: string; content: string; payload: MaterialPayload }[] = [];
  for (const raw of materials.slice(0, MAX_ITEMS_PER_CHAPTER)) {
    const item = sanitizeItem(raw);
    if (item) items.push(item);
  }
  return items;
}

function sanitizeItem(raw: unknown): ExtractedMaterial | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const type = record.type;
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, MAX_TITLE_LENGTH) : '';
  const content = typeof record.content === 'string' ? record.content.trim().slice(0, MAX_CONTENT_LENGTH) : '';
  if (typeof type !== 'string' || !(MATERIAL_TYPES as readonly string[]).includes(type)) return null;
  if (title === '' || content === '') return null;

  const allowedKeys = new Set(PAYLOAD_FIELDS[type as MaterialType].map((rule) => rule.key));
  const payload: MaterialPayload = {};
  if (record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)) {
    for (const [key, value] of Object.entries(record.payload)) {
      if (allowedKeys.has(key) && typeof value === 'string' && value.trim() !== '') {
        payload[key] = value.trim();
      }
    }
  }
  // 结构完整契约：书骨骼必须三键齐备（节奏曲线/卷纲结构/人物原型），残缺骨骼直接丢弃——
  // 否则确认入库时无法通过素材 schema 校验
  if (type === 'skeleton' && !PAYLOAD_FIELDS.skeleton.every((rule) => (payload[rule.key] ?? '') !== '')) {
    return null;
  }
  return { type: type as MaterialType, title, content, payload };
}
