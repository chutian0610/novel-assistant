import type { DB } from '../db/open';
import {
  CHARACTER_STATE_CATEGORIES,
  listCharacterRelations,
  listCharacterStates,
  listForeshadows,
  listTimelineEvents,
  replaceAutoFacts,
  type CharacterStateCategory,
  type ExtractedFacts,
  type FactSyncCounts,
} from './store';
import { getChapter } from '../pipeline/store';
import { RouteNotConfiguredError } from '../llm/routed';
import { parseLooseJson } from '../llm/parse';
import { resolveRoute } from '../llm/resolver';
import type { ChatMessage, LLMProvider } from '../llm/types';

/**
 * 落稿事实回灌（T12，ADR-0002 / spec 用户故事 31）：commit 后用 extract 任务路由从终稿提取
 * 四表事实（角色运行时增量 / 人物关系 / 时间轴事件 / 新伏笔），全部带来源章（= 本章）+ 原文证据。
 *
 * 幂等契约：replaceAutoFacts 整章替换本章 auto 行——同章重复 commit / 手动重灌不产生重复事实；
 * 人工事实（origin=manual）不受影响；伏笔按（埋设章，标题）去重，账本状态推进不被覆盖
 * （已知边界：LLM 二次提取微调标题会另立新条，由作者在账本里收敛）。
 *
 * 逐章增量 diff：prompt 的「此前事实库」只含第 idx 章之前的既有事实——LLM 只需登记本章
 * 新增/变化的状态；本章自身的 auto 行由整章替换语义负责，不进对照（避免「未变化不输出」
 * 撞上「本章先删后插」导致事实被清空）。
 */

/** 单次回灌各类条目上限（防 prompt 失控） */
const LIMITS = { states: 30, relations: 30, timeline: 20, foreshadows: 10 } as const;

/** 回灌上下文里各表最多带的现有条数 */
const CONTEXT_LIMIT = 100;

/** 提取文本字段的截长上限（与大纲展开解析同口径：trim 后截断） */
const MAX_NAME_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 2000;

/** 目标章缺失/非法时的兜底估计：埋设章 +20（宁松勿紧，避免提前触发超期预警） */
const DEFAULT_TARGET_HORIZON = 20;

export class FactParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactParseError';
  }
}

const EXTRACT_SYSTEM_PROMPT = `你是小说事实管理员。对照给定的【此前事实库】（第 N 章之前章节的既有事实），从正文中提取新增或发生变化的事实，用于逐章回灌。只输出 JSON，不要输出任何其他文字。格式：
{"characterStates":[{"name":"角色名","category":"injury|secret|possession|realm|other","content":"状态描述","evidence":"原文摘录"}],
"relations":[{"fromName":"角色甲","toName":"角色乙","relation":"关系","evidence":"原文摘录"}],
"timeline":[{"title":"事件标题","content":"事件经过","evidence":"原文摘录"}],
"foreshadows":[{"title":"伏笔名","content":"伏笔说明","targetChapter":预估回收章号,"evidence":"原文摘录"}]}
要求：
- 角色运行时只登记本章新增或发生变化的状态（对照此前事实库），此前已登记且未变化的不重复输出。
- 新埋的伏笔登记进 foreshadows；没有新伏笔输出空数组。
- evidence 必须是正文中出现的原句或原句片段（系统会做原文子串校验，编造的证据会被丢弃）。
- 某类没有条目就输出空数组。`;

/** 对第 idx 章做事实回灌：读已提交正文 → extract LLM → 证据校验 → 整章替换 auto 事实。失败由调用方落盘 */
export async function extractFacts(db: DB, llm: LLMProvider, bookId: number, idx: number): Promise<FactSyncCounts> {
  const chapter = getChapter(db, bookId, idx);
  if (!chapter) throw new Error(`书 ${bookId} 还没有第 ${idx} 章（应先由 API 层拦截）`);
  if (!resolveRoute(db, 'extract')) throw new RouteNotConfiguredError('extract');

  const result = await llm.complete('extract', {
    messages: buildExtractMessages(db, bookId, idx, chapter.content),
    temperature: 0.2,
    maxTokens: 4096,
  });
  const extracted = filterByEvidence(parseExtracted(result.content, idx), chapter.content);
  return replaceAutoFacts(db, bookId, idx, extracted);
}

/** 解析回灌响应：容忍围栏与前后杂讯；非法条目逐条丢弃（缺字段/非法类别），文本 trim 后按上限截断。targetChapter 缺失或非法时兜底为埋设章 +20（详见 DEFAULT_TARGET_HORIZON） */
export function parseExtracted(content: string, chapterIdx: number): ExtractedFacts {
  const parsed = parseLooseJson(content);
  if (!parsed) throw new FactParseError(`LLM 回灌响应不是合法的 JSON：${content.slice(0, 80)}`);

  const characterStates = sanitizeList(parsed.characterStates, LIMITS.states, (raw) =>
    sanitizeTexts(raw, ['name', 'category', 'content', 'evidence'], ({ name, category, content, evidence }) => {
      if (!CHARACTER_STATE_CATEGORIES.includes(category as CharacterStateCategory)) return null;
      return {
        name: cut(name, MAX_NAME_TITLE_CHARS),
        category: category as CharacterStateCategory,
        content: cut(content),
        evidence: cut(evidence),
      };
    })
  );

  const relations = sanitizeList(parsed.relations, LIMITS.relations, (raw) =>
    sanitizeTexts(raw, ['fromName', 'toName', 'relation', 'evidence'], ({ fromName, toName, relation, evidence }) => ({
      fromName: cut(fromName, MAX_NAME_TITLE_CHARS),
      toName: cut(toName, MAX_NAME_TITLE_CHARS),
      relation: cut(relation, MAX_NAME_TITLE_CHARS),
      evidence: cut(evidence),
    }))
  );

  const timeline = sanitizeList(parsed.timeline, LIMITS.timeline, (raw) =>
    sanitizeTexts(raw, ['title', 'content', 'evidence'], ({ title, content, evidence }) => ({
      title: cut(title, MAX_NAME_TITLE_CHARS),
      content: cut(content),
      evidence: cut(evidence),
    }))
  );

  const foreshadows = sanitizeList(parsed.foreshadows, LIMITS.foreshadows, (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rawTarget = Number((raw as Record<string, unknown>).targetChapter);
    const targetChapter =
      Number.isInteger(rawTarget) && rawTarget >= 1 && rawTarget <= 100_000 ? rawTarget : chapterIdx + DEFAULT_TARGET_HORIZON;
    return sanitizeTexts(raw, ['title', 'content', 'evidence'], ({ title, content, evidence }) => ({
      title: cut(title, MAX_NAME_TITLE_CHARS),
      content: cut(content),
      targetChapter,
      evidence: cut(evidence),
    }));
  });

  return { characterStates, relations, timeline, foreshadows };
}

/** 证据溯源校验（ADR-0002）：证据必须真出现在正文中（忽略空白差异），编造证据的条目整条丢弃 */
function filterByEvidence(extracted: ExtractedFacts, content: string): ExtractedFacts {
  const compact = (raw: string): string => raw.replace(/\s+/g, '');
  const haystack = compact(content);
  const found = (evidence: string): boolean => haystack.includes(compact(evidence));
  return {
    characterStates: extracted.characterStates.filter((state) => found(state.evidence)),
    relations: extracted.relations.filter((relation) => found(relation.evidence)),
    timeline: extracted.timeline.filter((event) => found(event.evidence)),
    foreshadows: extracted.foreshadows.filter((item) => found(item.evidence)),
  };
}

// ---------- 内部 ----------

/** 对照【此前事实库】构造提取 prompt：正文 + 第 idx 章之前的既有事实摘要（增量 diff 的参照） */
function buildExtractMessages(db: DB, bookId: number, idx: number, content: string): ChatMessage[] {
  // 角色运行时取（章号 < 本章）每角色×类目最新一条——与注入视图同一增量口径；
  // 本章自身的 auto 行不进对照（见模块注释的幂等契约）
  const states = [...listCharacterStates(db, bookId)]
    .sort((a, b) => a.chapter - b.chapter || a.id - b.id)
    .filter((state) => state.chapter < idx);
  const latest = new Map<string, (typeof states)[number]>();
  for (const state of states) latest.set(`${state.name}\u0000${state.category}`, state);
  const stateLines = [...latest.values()].map(
    (state) => `- ${state.name}·${state.category}（第${state.chapter}章）：${state.content}`
  );

  const relations = [...listCharacterRelations(db, bookId)]
    .filter((relation) => relation.chapter < idx)
    .slice(-CONTEXT_LIMIT)
    .map((relation) => `- ${relation.fromName} → ${relation.toName}：${relation.relation}（第${relation.chapter}章）`);

  const events = listTimelineEvents(db, bookId)
    .filter((event) => event.chapter < idx)
    .slice(-30)
    .map((event) => `- 第${event.chapter}章 ${event.title}`);

  const foreshadows = listForeshadows(db, bookId)
    .filter((item) => item.status === 'planted' || item.status === 'progressing')
    .slice(-CONTEXT_LIMIT)
    .map((item) => `- ${item.title}（${item.status}，埋设第${item.plantedChapter}章）`);

  const sections = [`【本章】第${idx}章`, `【正文】\n${content}`];
  if (stateLines.length > 0) sections.push(`【此前事实库·角色运行时】\n${stateLines.join('\n')}`);
  if (relations.length > 0) sections.push(`【此前事实库·人物关系】\n${relations.join('\n')}`);
  if (events.length > 0) sections.push(`【此前事实库·时间轴】\n${events.join('\n')}`);
  if (foreshadows.length > 0) sections.push(`【此前事实库·伏笔账本】\n${foreshadows.join('\n')}`);

  return [
    { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

/** 条目数组净化：逐条丢弃非法项，截断到上限 */
function sanitizeList<T>(
  raw: unknown,
  limit: number,
  sanitize: (raw: unknown) => T | null
): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw.slice(0, limit * 2)) {
    const value = sanitize(item);
    if (value) out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

/** 要求若干非空文本字段的净化器：任一缺失/空白返回 null（该条目被丢弃）；文本 trim 后由调用方按上限截断 */
function sanitizeTexts<K extends string, T>(
  raw: unknown,
  keys: readonly K[],
  project: (values: Record<K, string>) => T
): T | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const values = {} as Record<K, string>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') return null;
    values[key] = value.trim();
  }
  return project(values);
}

function cut(value: string, max = MAX_TEXT_CHARS): string {
  return value.slice(0, max);
}
