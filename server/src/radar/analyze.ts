import type { DB } from '../db/open';
import { parseLooseJson } from '../llm/parse';
import { RouteNotConfiguredError } from '../llm/routed';
import { resolveRoute } from '../llm/resolver';
import type { ChatMessage, LLMProvider } from '../llm/types';
import { getChapter } from '../pipeline/store';
import { replaceRadarMarks, THRILL_TYPES, HOOK_RATINGS, type AnalyzedRadar, type AnalyzedThrill, type HookRating, type ThrillType } from './store';

/**
 * 爽点雷达回灌（T18）：commit 后用 analyze 任务路由对终稿做语义评测——爽点标注（类型/
 * 原文位置/强度）+ 章末钩子评级。与事实回灌同款旁路模式：失败不阻塞提交、幂等整章
 * 替换、可手动重灌；结果是观测与预警维度，不进重写闸门。
 *
 * quote 纪律（ADR-0002 证据溯源口径）：LLM 只负责摘原句，span 由应用层 indexOf 定位
 * （LLM 报坐标不可靠）；quote 不在正文中的条目整条丢弃（编造不可审计）。
 */

/** 单章爽点标注上限（防 prompt 失控） */
const MAX_THRILLS = 20;

const MAX_TEXT_CHARS = 2000;

export class RadarParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RadarParseError';
  }
}

const ANALYZE_SYSTEM_PROMPT = `你是网文节奏评测员。对给定章节正文做爽点与章末钩子评测，只输出 JSON，不要输出任何其他文字。格式：
{"thrills":[{"type":"face_slap|breakthrough|reversal|gain|other","quote":"正文原句","intensity":3,"reason":"一句话理由"}],
"hook":{"rating":"strong|medium|weak|none","quote":"章末原句（无钩子可留空字符串）","reason":"一句话理由"}}
要求：
- thrills 登记本章的爽点/情绪高点：face_slap=打脸、breakthrough=晋级突破、reversal=反转、gain=获得宝物机缘、other=其他；
  没有爽点输出空数组。单章最多登记 5 个最显著的。
- intensity 为 1-5 的整数（5 = 全书级高光，1 = 轻微爽感）。
- quote 必须是正文中出现的原句或原句片段（系统做原文子串校验，编造的会被丢弃）。
- hook 评本章最后一段的追读钩子强度：strong=强悬念/强期待，medium=常规推进，weak=平淡收尾，none=完全断档。`;

/** 对第 idx 章做爽点评测：读已提交正文 → analyze LLM → 证据校验与 span 定位 → 整章替换标注。失败由调用方落盘 */
export async function analyzeChapter(db: DB, llm: LLMProvider, bookId: number, idx: number): Promise<void> {
  const chapter = getChapter(db, bookId, idx);
  if (!chapter) throw new Error(`书 ${bookId} 还没有第 ${idx} 章（应先由 API 层拦截）`);
  if (!resolveRoute(db, 'analyze')) throw new RouteNotConfiguredError('analyze');

  const result = await llm.complete('analyze', {
    messages: buildAnalyzeMessages(idx, chapter.title, chapter.content),
    temperature: 0.2,
    maxTokens: 2048,
  });
  const analyzed = locateSpans(filterByQuote(parseRadar(result.content), chapter.content), chapter.content);
  replaceRadarMarks(db, bookId, idx, analyzed);
}

/** 解析评测响应：容忍围栏与前后杂讯；非法条目逐条丢弃（类型/评级不在白名单、强度越界、缺 quote） */
export function parseRadar(content: string): AnalyzedRadar {
  const parsed = parseLooseJson(content);
  if (!parsed) throw new RadarParseError(`LLM 雷达响应不是合法的 JSON：${content.slice(0, 80)}`);

  const rawThrills = Array.isArray(parsed.thrills) ? parsed.thrills : [];
  const thrills: AnalyzedThrill[] = [];
  for (const raw of rawThrills.slice(0, MAX_THRILLS * 2)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (!THRILL_TYPES.includes(record.type as ThrillType)) continue;
    if (typeof record.quote !== 'string' || record.quote.trim() === '') continue;
    const intensity = Number(record.intensity);
    if (!Number.isInteger(intensity) || intensity < 1 || intensity > 5) continue;
    thrills.push({
      type: record.type as ThrillType,
      quote: cut(record.quote.trim()),
      intensity,
      reason: typeof record.reason === 'string' ? cut(record.reason.trim()) : '',
      spanStart: null,
      spanEnd: null,
    });
    if (thrills.length >= MAX_THRILLS) break;
  }

  let hook: AnalyzedRadar['hook'] = null;
  const rawHook = parsed.hook;
  if (rawHook && typeof rawHook === 'object' && !Array.isArray(rawHook)) {
    const record = rawHook as Record<string, unknown>;
    if (HOOK_RATINGS.includes(record.rating as HookRating)) {
      const quote = typeof record.quote === 'string' ? record.quote.trim() : '';
      hook = {
        rating: record.rating as HookRating,
        quote: cut(quote),
        reason: typeof record.reason === 'string' ? cut(record.reason.trim()) : '',
        spanStart: null,
        spanEnd: null,
      };
    }
  }

  return { thrills, hook };
}

/** quote 溯源校验：必须真出现在正文中（忽略空白差异），编造的条目整条丢弃 */
function filterByQuote(analyzed: AnalyzedRadar, content: string): AnalyzedRadar {
  const compact = (raw: string): string => raw.replace(/\s+/g, '');
  const haystack = compact(content);
  return {
    thrills: analyzed.thrills.filter((thrill) => haystack.includes(compact(thrill.quote))),
    hook:
      analyzed.hook && (analyzed.hook.quote === '' || haystack.includes(compact(analyzed.hook.quote)))
        ? analyzed.hook
        : null,
  };
}

/** span 定位：正文原文 indexOf（quote 与正文逐字一致时给出精确区间；空白差异导致找不到时保持 null） */
function locateSpans(analyzed: AnalyzedRadar, content: string): AnalyzedRadar {
  const locate = (quote: string): { spanStart: number | null; spanEnd: number | null } => {
    const start = quote === '' ? -1 : content.indexOf(quote);
    return start >= 0 ? { spanStart: start, spanEnd: start + quote.length } : { spanStart: null, spanEnd: null };
  };
  return {
    thrills: analyzed.thrills.map((thrill) => ({ ...thrill, ...locate(thrill.quote) })),
    hook: analyzed.hook ? { ...analyzed.hook, ...locate(analyzed.hook.quote) } : null,
  };
}

function buildAnalyzeMessages(idx: number, title: string, content: string): ChatMessage[] {
  return [
    { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
    { role: 'user', content: `【本章】第${idx}章 ${title}\n\n【正文】\n${content}` },
  ];
}

function cut(value: string, max = MAX_TEXT_CHARS): string {
  return value.slice(0, max);
}
