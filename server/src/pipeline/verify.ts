import { getDetectorConfig } from '../detectors/config';
import {
  analyzeText,
  METRIC_LABELS,
  splitSentences,
  type DetectionReport,
  type MetricResult,
  type MetricThreshold,
} from '../detectors/metrics';
import type { DB } from '../db/open';
import { extractFacts } from '../facts/extract-facts';
import { analyzeChapter } from '../radar/analyze';
import { syncChapterBlockEmbeddings } from '../embeddings/store';
import { listCharacterRelations, listCharacterStates, listForeshadows, listTimelineEvents } from '../facts/store';
import { RouteNotConfiguredError } from '../llm/routed';
import { resolveRoute } from '../llm/resolver';
import { parseLooseJson } from '../llm/parse';
import type { ChatMessage, LLMProvider } from '../llm/types';
import { PackingRangeError } from '../packing/pack';
import {
  advanceRun,
  commitChapterRun,
  type CommitOutcome,
  countPendingSuspensions,
  createSuspension,
  getRun,
  listSuspensions,
  resolveSuspension,
  upsertChapterMetrics,
  type PipelineRunRecord,
  type PipelineStage,
  type SemanticConflict,
  type SemanticReport,
  type SuspensionRecord,
} from './store';

/**
 * verify→fix 闭环（T11）：verify 出双报告（8 维确定性检测 + LLM 语义核查对照事实库），
 * fix 对不达标段落定向重写（只动问题段落、带前后文保文风，默认最多 2 轮），
 * 轮次用尽仍不达标或存在语义冲突 → 挂起进人工裁决队列。
 *
 * 断点续跑契约与 prepare/draft 一致：双报告落盘后 stage 推进到 fix；
 * fix 每轮重写后清空报告、stage 退回 verify 强制复检；挂起（status=suspended）后
 * 队列裁决/重写动作经同一入口 driveVerification 续跑。
 *
 * 闸门规则（gate）：
 * - 检测：有不达标维时先走 fix 轮；轮次用尽后看当前轮（round = fixRounds）的挂起项——
 *   有 pending 即挂起，全部已裁决（ignore/fact）视作人工放行，无项则建项挂起。
 * - 语义：冲突项按 quote 对账——pending 与当前冲突集保持一致（消失的自动消除），
 *   已裁决（ignore/fact）的 quote 不再重建；有 pending 即挂起。
 */

/** 定向重写默认最多 2 轮（spec Further Notes；接入点预留 verify/fix 之后仍适用） */
export const MAX_FIX_ROUNDS = 2;

/** 语义冲突清单上限（防 prompt 失控） */
const MAX_CONFLICTS = 20;

/** 事实库各表进入核查上下文的条数上限 */
const FACT_CONTEXT_LIMIT = 100;

/** 阶段执行失败（产物已落盘、run 已记 failed），API 层映射 502 */
export class PipelineStageError extends Error {
  constructor(
    public readonly stage: PipelineStage,
    message: string
  ) {
    super(message);
    this.name = 'PipelineStageError';
  }
}

/** LLM 语义核查产出不合法（非 JSON / 字段缺失） */
export class SemanticParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticParseError';
  }
}

export type GateVerdict = 'commit' | 'suspended';

/**
 * verify→fix 主循环：从当前 run 状态驱动到「可 commit」或「挂起」。
 * 入口 stage 必须是 verify（报告未出）或 fix（报告已出待闸门）。
 */
export async function driveVerification(
  db: DB,
  llm: LLMProvider,
  bookId: number,
  idx: number
): Promise<GateVerdict> {
  for (;;) {
    const run = requireRun(db, bookId, idx);
    if (run.stage === 'verify') {
      await executeVerify(db, llm, bookId, idx, run);
      continue;
    }
    if (run.stage !== 'fix') return 'commit';
    const outcome = await runGate(db, llm, bookId, idx, run);
    if (outcome === 'suspended') return 'suspended';
    if (outcome === 'loop') continue;
    return 'commit';
  }
}

// ---------- verify：双报告 ----------

/** 语义核查 system prompt：对照事实库找矛盾，只输出 JSON */
const SEMANTIC_SYSTEM_PROMPT = `你是小说事实核查员。对照给定的事实库检查正文是否存在与之矛盾的设定或情节（人物状态、人物关系、时间线、伏笔等）。
只输出 JSON，不要输出任何其他文字。格式：
{"conflicts":[{"quote":"正文中矛盾的原句","explanation":"矛盾说明","factHint":"冲突的事实摘要"}]}
无矛盾时 conflicts 为空数组。quote 必须是正文中的原句摘录。`;

async function executeVerify(db: DB, llm: LLMProvider, bookId: number, idx: number, run: PipelineRunRecord): Promise<void> {
  const draft = run.draftContent;
  if (draft === null) throw new Error('draft 产物缺失（断点状态不一致）');

  let semantic: SemanticReport;
  try {
    if (!resolveRoute(db, 'verify')) throw new RouteNotConfiguredError('verify');
    const result = await llm.complete('verify', {
      messages: buildSemanticMessages(db, bookId, draft),
      temperature: 0.2,
      maxTokens: 4096,
    });
    semantic = { conflicts: parseConflicts(result.content) };
  } catch (cause) {
    failRun(db, bookId, idx, run.attempts + 1, 'verify', cause);
  }
  // 8 维确定性检测：纯函数，与语义核查并行出报告
  const detection = analyzeText(draft, getDetectorConfig(db));
  advanceRun(db, bookId, idx, {
    stage: 'fix',
    status: 'running',
    attempts: run.attempts + 1,
    error: null,
    detectionReport: detection,
    semanticReport: semantic,
  });
  // 指标按章落库（跨章趋势数据源）；每轮复检后覆盖为最新
  upsertChapterMetrics(db, bookId, idx, {
    aiScore: detection.aiScore,
    confidence: detection.confidence,
    adjustedScore: detection.adjustedScore,
    wordCount: detection.wordCount,
    metrics: detection.metrics,
  });
}

/** 解析语义核查响应：容忍代码围栏与前后杂讯；非法条目逐条丢弃，整体不可解析视为失败 */
export function parseConflicts(content: string): SemanticConflict[] {
  const parsed = parseLooseJson(content);
  const rawConflicts = parsed && Array.isArray(parsed.conflicts) ? (parsed.conflicts as unknown[]) : null;
  if (!rawConflicts) throw new SemanticParseError(`LLM 语义核查响应不是合法的 JSON：${content.slice(0, 80)}`);

  const conflicts: SemanticConflict[] = [];
  for (const raw of rawConflicts.slice(0, MAX_CONFLICTS)) {
    const conflict = sanitizeConflict(raw);
    if (conflict) conflicts.push(conflict);
  }
  return conflicts;
}

function sanitizeConflict(raw: unknown): SemanticConflict | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const quote = typeof record.quote === 'string' ? record.quote.trim() : '';
  const explanation = typeof record.explanation === 'string' ? record.explanation.trim() : '';
  const factHint = typeof record.factHint === 'string' ? record.factHint.trim() : '';
  if (quote === '' || explanation === '') return null;
  return { quote, explanation, factHint };
}

/** 核查上下文：正文 + 事实库四表（截取最近 FACT_CONTEXT_LIMIT 条） */
function buildSemanticMessages(db: DB, bookId: number, draft: string): ChatMessage[] {
  const states = listCharacterStates(db, bookId).slice(-FACT_CONTEXT_LIMIT);
  const relations = listCharacterRelations(db, bookId).slice(-FACT_CONTEXT_LIMIT);
  const events = listTimelineEvents(db, bookId).slice(-FACT_CONTEXT_LIMIT);
  const foreshadows = listForeshadows(db, bookId).slice(-FACT_CONTEXT_LIMIT);

  const sections: string[] = [`【正文】\n${draft}`];
  if (states.length > 0) {
    sections.push(
      `【角色运行时】\n${states.map((state) => `- ${state.name}·${state.category}（第${state.chapter}章）：${state.content}`).join('\n')}`
    );
  }
  if (relations.length > 0) {
    sections.push(
      `【人物关系】\n${relations.map((relation) => `- ${relation.fromName} → ${relation.toName}：${relation.relation}（第${relation.chapter}章）`).join('\n')}`
    );
  }
  if (events.length > 0) {
    sections.push(`【时间轴】\n${events.map((event) => `- 第${event.chapter}章 ${event.title}：${event.content}`).join('\n')}`);
  }
  if (foreshadows.length > 0) {
    sections.push(
      `【伏笔账本】\n${foreshadows.map((item) => `- ${item.title}（${item.status}，埋设第${item.plantedChapter}章，目标第${item.targetChapter}章）`).join('\n')}`
    );
  }
  return [
    { role: 'system', content: SEMANTIC_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

// ---------- fix：定向重写 ----------

/** fix system prompt：只重写问题段落，保留前后文风格 */
const FIX_SYSTEM_PROMPT = `你是网文修订者。只重写给定的【待重写段落】，修复【需修复的问题】中指出的统计缺陷。
保持前后文的语气、人称与情节连续；不要新增解释、前后缀或任何多余文字；输出重写后的段落文本本身。`;

async function executeFixRound(
  db: DB,
  llm: LLMProvider,
  bookId: number,
  idx: number,
  run: PipelineRunRecord,
  failing: MetricResult[]
): Promise<void> {
  const draft = run.draftContent;
  const detection = run.detectionReport;
  if (draft === null || detection === null) throw new Error('verify 产物缺失（断点状态不一致）');
  if (detection.sentences.length === 0) throw new Error('正文为空，无法定位待重写段落');
  if (!resolveRoute(db, 'draft')) throw new RouteNotConfiguredError('draft');

  const sentences = detection.sentences;
  const spans = locateSentenceSpans(draft, sentences);
  // 句级证据并集按连续索引合并为段；仅全文级维度失败时整体重写（无法定位段落）
  const hits = [...new Set(failing.filter((metric) => metric.hits.length > 0).flatMap((metric) => metric.hits))].sort(
    (a, b) => a - b
  );
  const segments = hits.length > 0 ? groupContiguous(hits) : [{ first: 0, last: sentences.length - 1 }];
  const problemText = failing
    .map((metric) => `${METRIC_LABELS[metric.key]}（当前 ${formatValue(metric.value)}，阈值 ${formatThreshold(metric.threshold)}）`)
    .join('；');

  // 从后往前替换：段 span 基于当前内容定位，前面的段不受影响
  let content = draft;
  for (const segment of [...segments].reverse()) {
    const first = spans[segment.first]!;
    const last = spans[segment.last]!;
    const segmentText = content.slice(first.start, last.end);
    const before = sentences.slice(Math.max(0, segment.first - 2), segment.first).join('');
    const after = sentences.slice(segment.last + 1, segment.last + 3).join('');
    const rewritten = await rewriteSegment(llm, { segmentText, before, after, problemText });
    content = content.slice(0, first.start) + rewritten + content.slice(last.end);
  }

  advanceRun(db, bookId, idx, {
    stage: 'verify',
    status: 'running',
    attempts: run.attempts + 1,
    error: null,
    draftContent: content,
    fixRounds: run.fixRounds + 1,
    detectionReport: null,
    semanticReport: null,
  });
}

async function rewriteSegment(
  llm: LLMProvider,
  input: { segmentText: string; before: string; after: string; problemText: string }
): Promise<string> {
  const lines = [];
  if (input.before !== '') lines.push(`【上下文前文】${input.before}`);
  if (input.after !== '') lines.push(`【上下文后文】${input.after}`);
  lines.push(`【待重写段落】${input.segmentText}`);
  lines.push(`【需修复的问题】${input.problemText}`);
  const result = await llm.complete('draft', {
    messages: [
      { role: 'system', content: FIX_SYSTEM_PROMPT },
      { role: 'user', content: lines.join('\n') },
    ],
    temperature: 0.8,
    maxTokens: 4096,
  });
  const rewritten = result.content.trim();
  if (rewritten === '') throw new Error('LLM 返回的重写段落为空');
  return rewritten;
}

/** 句子在正文中的精确 span（切句保留标点、按序出现，顺序扫描即可对齐） */
function locateSentenceSpans(content: string, sentences: string[]): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let pointer = 0;
  for (const sentence of sentences) {
    const start = content.indexOf(sentence, pointer);
    if (start === -1) throw new Error('正文与检测报告切句失同步（断点状态不一致）');
    spans.push({ start, end: start + sentence.length });
    pointer = start + sentence.length;
  }
  return spans;
}

/** 连续句索引合并为段（段内连续重写一次完成，段间独立） */
function groupContiguous(indices: number[]): { first: number; last: number }[] {
  const groups: { first: number; last: number }[] = [];
  let first = indices[0]!;
  let last = indices[0]!;
  for (const index of indices.slice(1)) {
    if (index === last + 1) {
      last = index;
    } else {
      groups.push({ first, last });
      first = index;
      last = index;
    }
  }
  groups.push({ first, last });
  return groups;
}

function formatValue(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function formatThreshold(threshold: MetricThreshold): string {
  return typeof threshold === 'number' ? formatValue(threshold) : `${formatValue(threshold.min)}~${formatValue(threshold.max)}`;
}

// ---------- 闸门 ----------

async function runGate(
  db: DB,
  llm: LLMProvider,
  bookId: number,
  idx: number,
  run: PipelineRunRecord
): Promise<'commit' | 'suspended' | 'loop'> {
  const detection = run.detectionReport;
  if (detection === null) throw new Error('verify 报告缺失（断点状态不一致）');
  const failing = detection.metrics.filter((metric) => !metric.pass && !metric.skipped);

  // 检测闸门：不达标先走 fix 轮；轮次用尽看当前轮挂起项（人工裁决）。
  // 语义闸门在其后串行执行是有意的：fix 每轮都会改写正文并复检，先对账语义项会为
  // 即将被重写的正文建队列传票；检测放行（或被人工放行）后的正文才进入最终语义裁决。
  if (failing.length > 0) {
    if (run.fixRounds < MAX_FIX_ROUNDS) {
      await executeFixRound(db, llm, bookId, idx, run, failing);
      return 'loop';
    }
    const currentRound = listSuspensions(db, bookId, { idx }).filter(
      (item) => item.source === 'detection' && item.round === run.fixRounds
    );
    if (currentRound.some((item) => item.status === 'pending')) return 'suspended';
    if (currentRound.length === 0) {
      createDetectionItems(db, bookId, idx, detection, run.fixRounds);
      advanceRun(db, bookId, idx, { stage: 'fix', status: 'suspended', attempts: run.attempts, error: null });
      return 'suspended';
    }
    // 当前轮全部裁决（ignore/fact）→ 人工放行
  }

  // 语义闸门：冲突项按 quote 对账，有 pending 即挂起
  const conflicts = run.semanticReport?.conflicts ?? [];
  reconcileSemanticItems(db, bookId, idx, conflicts, run.fixRounds);
  if (countPendingSuspensions(db, bookId, idx, 'semantic') > 0) {
    advanceRun(db, bookId, idx, { stage: 'fix', status: 'suspended', attempts: run.attempts, error: null });
    return 'suspended';
  }
  return 'commit';
}

/**
 * 轮次用尽时建检测挂起项：句级证据维度逐维建项（带命中句），全文级维度聚合一项。
 * 旧轮的 pending 项一律以 auto 收尾（被当前轮项取代），避免队列跨轮重复堆积。
 */
function createDetectionItems(db: DB, bookId: number, idx: number, detection: DetectionReport, round: number): void {
  for (const item of listSuspensions(db, bookId, { idx })) {
    if (item.source === 'detection' && item.status === 'pending' && item.round !== round) {
      resolveSuspension(db, bookId, idx, item.id, 'auto');
    }
  }
  const failing = detection.metrics.filter((metric) => !metric.pass && !metric.skipped);
  for (const metric of failing) {
    if (metric.hits.length === 0) continue;
    createSuspension(db, bookId, idx, {
      source: 'detection',
      title: `检测未达标：${METRIC_LABELS[metric.key]}`,
      reason: `${METRIC_LABELS[metric.key]} 当前 ${formatValue(metric.value)}，阈值 ${formatThreshold(metric.threshold)}`,
      detail: {
        metricKey: metric.key,
        hits: metric.hits,
        sentences: metric.hits.map((hit) => detection.sentences[hit] ?? ''),
      },
      round,
    });
  }
  const fullText = failing.filter((metric) => metric.hits.length === 0);
  if (fullText.length > 0) {
    createSuspension(db, bookId, idx, {
      source: 'detection',
      title: '检测未达标：全文级维度',
      reason: fullText.map((metric) => `${METRIC_LABELS[metric.key]} 当前 ${formatValue(metric.value)}`).join('；'),
      detail: { metricKeys: fullText.map((metric) => metric.key), fullText: true },
      round,
    });
  }
}

/**
 * 语义项与当前冲突集对账：pending 且冲突消失 → 自动消除；
 * 已裁决（ignore/fact）的 quote 不再重建（人工结论优先）；新冲突建项。
 */
function reconcileSemanticItems(
  db: DB,
  bookId: number,
  idx: number,
  conflicts: SemanticConflict[],
  round: number
): void {
  const existing = listSuspensions(db, bookId, { idx }).filter((item) => item.source === 'semantic');
  const quotes = new Set(conflicts.map((conflict) => conflict.quote));
  for (const item of existing) {
    if (item.status === 'pending' && !quotes.has(item.detail.quote ?? '')) {
      resolveSuspension(db, bookId, idx, item.id, 'auto');
    }
  }
  const keptPending = new Set(
    existing.filter((item) => item.status === 'pending' && quotes.has(item.detail.quote ?? '')).map((item) => item.detail.quote ?? '')
  );
  const decidedQuotes = new Set(
    existing.filter((item) => item.status === 'resolved' && quotes.has(item.detail.quote ?? '')).map((item) => item.detail.quote ?? '')
  );
  for (const conflict of conflicts) {
    if (keptPending.has(conflict.quote) || decidedQuotes.has(conflict.quote)) continue;
    createSuspension(db, bookId, idx, {
      source: 'semantic',
      title: '事实矛盾',
      reason: conflict.explanation,
      detail: { quote: conflict.quote, explanation: conflict.explanation, factHint: conflict.factHint },
      round,
    });
  }
}

/**
 * commit 阶段 + 落稿回灌（T12 事实回灌 + T18 爽点雷达回灌）：单事务原子落盘后，
 * 用 extract / analyze 任务路由分别回灌四表事实与爽点标注。两条回灌互为旁路、
 * 互不阻塞（含不阻塞彼此）：失败分别落盘 runs.extract_error / runs.radar_error，
 * 可经各自的手动重灌端点恢复。generate 主流程与挂起队列的重写/裁决动作都经由这里收尾。
 */
export async function commitWithFactSync(db: DB, llm: LLMProvider, bookId: number, idx: number): Promise<CommitOutcome> {
  const outcome = commitChapterRun(db, bookId, idx);
  let factMessage: string | null = null;
  try {
    await extractFacts(db, llm, bookId, idx);
  } catch (cause) {
    factMessage = `事实回灌失败：${cause instanceof Error ? cause.message : String(cause)}`;
  }
  let radarMessage: string | null = null;
  try {
    await analyzeChapter(db, llm, bookId, idx);
  } catch (cause) {
    radarMessage = `爽点回灌失败：${cause instanceof Error ? cause.message : String(cause)}`;
  }
  // 正文块向量（T19）：第三旁路，失败静默——块缺失只影响呼应检索与查重，无错误列
  try {
    await syncChapterBlockEmbeddings(db, llm, bookId, idx);
  } catch {
    // 静默跳过（路由未配置或嵌入失败，查询侧自动缺席）
  }
  return {
    ...outcome,
    run: settleFactSync(db, bookId, idx, outcome.run.attempts, factMessage, radarMessage),
  };
}

/**
 * 回灌结果落盘（commit 之后的旁路标记，非阶段执行、不增 attempts）：
 * message 为 null 表示回灌成功；失败信息落 runs.extract_error 供写作台提示与手动重灌。
 */
export function settleFactSync(
  db: DB,
  bookId: number,
  idx: number,
  attempts: number,
  message: string | null,
  radarMessage: string | null = null
): PipelineRunRecord {
  advanceRun(db, bookId, idx, { stage: 'done', status: 'done', attempts, error: null, extractError: message, radarError: radarMessage });
  return getRun(db, bookId, idx)!;
}


// ---------- 挂起队列动作（一键重写 / 一键裁决） ----------

/**
 * 挂起项一键重写：按项定位问题段（检测句级证据 / 全文 / 语义引文），重写一轮后
 * 清报告退回 verify 复检，经同一闸门决定 commit 或再次挂起。
 */
export async function rewriteFromSuspension(
  db: DB,
  llm: LLMProvider,
  bookId: number,
  idx: number,
  item: SuspensionRecord
): Promise<void> {
  const run = requireRun(db, bookId, idx);
  const draft = run.draftContent;
  if (draft === null) throw new Error('draft 产物缺失（断点状态不一致）');

  // 定位重写 span（挂起期间正文被编辑守卫冻结，与生成挂起项时的内容一致）
  let start: number;
  let end: number;
  let before = '';
  let after = '';
  if (item.source === 'semantic') {
    const quote = item.detail.quote ?? '';
    start = draft.indexOf(quote);
    if (quote === '' || start === -1) throw new Error('引文已不在当前正文中，请改为忽略或手工编辑正文');
    end = start + quote.length;
  } else {
    const sentences = splitSentences(draft);
    const spans = locateSentenceSpans(draft, sentences);
    if (item.detail.fullText) {
      start = 0;
      end = draft.length;
    } else {
      const hits = item.detail.hits ?? [];
      if (hits.length === 0) throw new Error('挂起项缺少句级证据，无法定向重写');
      const first = spans[hits[0]!]!;
      const last = spans[hits[hits.length - 1]!]!;
      start = first.start;
      end = last.end;
      before = sentences.slice(Math.max(0, hits[0]! - 2), hits[0]!).join('');
      after = sentences.slice(hits[hits.length - 1]! + 1, hits[hits.length - 1]! + 3).join('');
    }
  }

  if (!resolveRoute(db, 'draft')) throw new RouteNotConfiguredError('draft');
  // 矛盾定位重写（T12）：语义项的重写指令带矛盾说明与事实线索，模型知道该向事实看齐
  const problemText =
    item.source === 'semantic' && item.detail.factHint
      ? `${item.reason}；相关事实：${item.detail.factHint}`
      : item.reason;
  const rewritten = await rewriteSegment(llm, {
    segmentText: draft.slice(start, end),
    before,
    after,
    problemText,
  });
  const content = draft.slice(0, start) + rewritten + draft.slice(end);

  advanceRun(db, bookId, idx, {
    stage: 'verify',
    status: 'running',
    attempts: run.attempts + 1,
    error: null,
    draftContent: content,
    fixRounds: run.fixRounds + 1,
    detectionReport: null,
    semanticReport: null,
  });
  resolveSuspension(db, bookId, idx, item.id, 'rewrite');
  if (await driveVerification(db, llm, bookId, idx) === 'commit') {
    await commitWithFactSync(db, llm, bookId, idx);
  }
}

/** 挂起项裁决：落决议；若该书该章已无 pending 且 run 挂起中 → 续跑闸门（可能直接 commit） */
export async function resolveFromSuspension(
  db: DB,
  llm: LLMProvider,
  bookId: number,
  idx: number,
  item: SuspensionRecord,
  resolution: 'ignore' | 'fact'
): Promise<void> {
  resolveSuspension(db, bookId, idx, item.id, resolution);
  const run = requireRun(db, bookId, idx);
  if (run.status === 'suspended' && countPendingSuspensions(db, bookId, idx) === 0) {
    advanceRun(db, bookId, idx, { stage: 'fix', status: 'running', attempts: run.attempts, error: null });
    if (await driveVerification(db, llm, bookId, idx) === 'commit') {
      await commitWithFactSync(db, llm, bookId, idx);
    }
  }
}

// ---------- 内部 ----------

function requireRun(db: DB, bookId: number, idx: number): PipelineRunRecord {
  const run = getRun(db, bookId, idx);
  if (!run) throw new Error(`管线状态缺失：book ${bookId} 第 ${idx} 章`);
  return run;
}

/** 阶段失败统一落盘后抛出：路由未配置原样上抛（API 层 409），其余包装为阶段错误（502）。
 *  run.ts（prepare/draft 阶段）与本文件（verify/fix 阶段）共用，PackingRangeError 仅 prepare 可能抛出。 */
export function failRun(db: DB, bookId: number, idx: number, attempts: number, stage: PipelineStage, cause: unknown): never {
  const message = cause instanceof Error ? cause.message : String(cause);
  advanceRun(db, bookId, idx, { stage, status: 'failed', attempts, error: message });
  if (cause instanceof RouteNotConfiguredError) throw cause;
  if (cause instanceof PackingRangeError) throw cause;
  throw new PipelineStageError(stage, `${stage} 阶段失败：${message}`);
}
