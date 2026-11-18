import type { LLMProvider } from '../llm/types';
import type { BookRecord } from '../books/store';
import { OUTLINE_STATUS_LABELS, type ChapterOutlineRecord, type VolumeRecord } from './store';

/** 展开方案：AI 对某一章的一种剧情展开提案（index 从 1 起，供作者选定引用） */
export interface ExpansionOption {
  index: number;
  title: string;
  summary: string;
}

export interface ExpansionResult {
  options: ExpansionOption[];
  /** 产出方案的生效模型（路由解析结果透传） */
  model: string;
}

/** LLM 产出不合法（非 JSON / 方案数不达 3 个下限）——API 层映射 502 */
export class OutlineParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutlineParseError';
  }
}

/** 方案数契约（spec 用户故事 17）：一次 3-5 个，作者选定其中一个 */
const MIN_OPTIONS = 3;
const MAX_OPTIONS = 5;
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 20_000;

const EXPAND_PROMPT = `你是网文大纲编辑。给定书契约、卷纲与某章的当前章纲，为该章提出 3-5 个差异化的剧情展开方案：每个方案包含章节标题（title）与 100-200 字的展开概要（summary），方案之间在冲突来源、推进方式、章末钩子上应有明显差异。
只输出 JSON，不要输出任何其他文字。格式：
{"options":[{"title":"章节标题","summary":"剧情展开概要"}]}`;

export interface ExpandContext {
  book: BookRecord;
  volume: VolumeRecord;
  chapter: ChapterOutlineRecord;
  /** 卷在书内的序号（1 起）与章在书内的全局序号（1 起），供模型定位叙事位置 */
  volumeOrdinal: number;
  chapterOrdinal: number;
  /** 作者对展开方向的附加要求，可省略 */
  hint?: string;
}

/** 一次调用产出 3-5 个展开方案（outline 任务路由），方案无状态：作者选定后由普通编辑接口写入 */
export async function expandChapterOutline(llm: LLMProvider, ctx: ExpandContext): Promise<ExpansionResult> {
  const { book, volume, chapter } = ctx;
  const lines = [
    `【书契约】题材：${book.genre || '未填'}；基调：${book.tone || '未填'}；对读者的承诺：${book.promise || '未填'}`,
    `【卷纲】第${ctx.volumeOrdinal}卷《${volume.title}》概述：${volume.summary || '（无）'}`,
    `【本章】第${ctx.chapterOrdinal}章《${chapter.title}》（当前状态：${OUTLINE_STATUS_LABELS[chapter.status]}）\n当前章纲：${chapter.summary || '（空）'}`,
  ];
  if (ctx.hint) lines.push(`【作者要求】${ctx.hint}`);

  const result = await llm.complete('outline', {
    messages: [
      { role: 'system', content: EXPAND_PROMPT },
      { role: 'user', content: lines.join('\n') },
    ],
    temperature: 0.8,
    maxTokens: 4096,
  });
  return { options: parseOptions(result.content), model: result.model };
}

/** 解析 LLM 响应：容忍代码围栏与前后杂讯；非法条目逐条丢弃，有效方案不足 3 个视为整体失败 */
export function parseOptions(content: string): ExpansionOption[] {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  let parsed: unknown;
  if (start !== -1 && end > start) {
    try {
      parsed = JSON.parse(content.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  const rawOptions =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { options?: unknown }).options)
      ? ((parsed as { options: unknown[] }).options)
      : null;
  if (!rawOptions) throw new OutlineParseError(`LLM 响应不是合法的展开方案 JSON：${content.slice(0, 80)}`);

  const options: { title: string; summary: string }[] = [];
  for (const raw of rawOptions.slice(0, MAX_OPTIONS)) {
    const option = sanitizeOption(raw);
    if (option) options.push(option);
  }
  if (options.length < MIN_OPTIONS) {
    throw new OutlineParseError(`LLM 只给出 ${options.length} 个有效展开方案，不足 ${MIN_OPTIONS} 个下限`);
  }
  return options.map((option, i) => ({ ...option, index: i + 1 }));
}

function sanitizeOption(raw: unknown): { title: string; summary: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, MAX_TITLE_LENGTH) : '';
  const summary = typeof record.summary === 'string' ? record.summary.trim().slice(0, MAX_SUMMARY_LENGTH) : '';
  if (title === '' || summary === '') return null;
  return { title, summary };
}
