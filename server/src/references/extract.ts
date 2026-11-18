import { resolveRoute } from '../llm/resolver';
import { RouteNotConfiguredError } from '../llm/routed';
import { LLMError, type ChatRequest, type LLMProvider } from '../llm/types';
import { MATERIAL_TYPES, PAYLOAD_FIELDS, type MaterialPayload, type MaterialType } from '../materials/store';
import type { DB } from '../db/open';
import { insertExtractionItems, markChapterDone, pendingChapters, remainingChapterCount } from './store';

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
          items.map((item) => ({ ...item, chapterId: chapter.id }))
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
export function parseExtraction(content: string): { type: MaterialType; title: string; content: string; payload: MaterialPayload }[] {
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

function sanitizeItem(raw: unknown): { type: MaterialType; title: string; content: string; payload: MaterialPayload } | null {
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
  return { type: type as MaterialType, title, content, payload };
}
