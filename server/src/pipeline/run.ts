import { getBook, touchBook } from '../books/store';
import type { DB } from '../db/open';
import { RouteNotConfiguredError } from '../llm/routed';
import { resolveRoute } from '../llm/resolver';
import type { ChatMessage, LLMProvider } from '../llm/types';
import { getChapterOutline, OUTLINE_STATUS_LABELS } from '../outlines/store';
import {
  buildInjectionView,
  locateChapterOutline,
  PackingRangeError,
  type FlatChapter,
  type InjectionView,
} from '../packing/pack';
import { commitWithFactSync, driveVerification, failRun } from './verify';
import {
  advanceRun,
  createRun,
  deriveSummary,
  getRun,
  type ChapterRecord,
  type ChapterSnapshotRecord,
  type PipelineRunRecord,
} from './store';

/**
 * 章节管线执行器（ADR-0001 五阶段状态机，T10 骨架 + T11 闭环）：prepare → draft → verify → fix → commit。
 *
 * 断点续跑契约（spec 用户故事 22）：
 * - 管线状态表 pipeline_runs 按（书，章号）唯一，stage 记录下一个待执行阶段；
 * - 每个阶段的产物先落盘再进入下一阶段：prepare 落注入视图 JSON，draft 落正文草稿，
 *   verify 落双报告（8 维检测 + LLM 语义核查）；fix 每轮重写落新草稿并清报告强制复检；
 * - 重启后续跑时，产物已在的阶段直接跳过——LLM 不重复调用、装填不重复计算；
 * - 失败（LLM 出错/路由未配置/返回空正文）落盘为 failed，可再次调用从断点恢复；
 * - verify→fix 闸门未过（重写轮次用尽 / 语义冲突）→ status=suspended 挂起，经挂起队列裁决后续跑；
 * - 已 done 的章再次生成 = 全新 run 重跑（覆盖正文并新增 pipeline 快照）。
 *
 * commit 在单事务内原子更新正文与派生物（章节行 + pipeline 快照 + run 终态）。
 */

/** 前置校验失败（章纲缺失/超范围/未批准）——不创建运行记录，API 层映射 409 */
export class PipelinePreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelinePreconditionError';
  }
}

/** 单章字数规格（CONTEXT.md「书」：2000-4000 字）对应的上限 */
const DRAFT_MAX_TOKENS = 8192;

const DRAFT_SYSTEM_PROMPT = `你是网文作者。根据给定的书契约、本章大纲、出场角色运行时与相关素材，写出本章正文。要求：
- 只输出正文本身：不要输出章节标题、序号、小标题、说明或任何额外文字。
- 篇幅 2000-4000 字。
- 遵守书契约的题材与基调，按本章大纲推进剧情，人物言行与角色运行时保持一致。`;

export interface PipelineResult {
  /** commit 完成返回章节；挂起（闸门未过）返回 null */
  chapter: ChapterRecord | null;
  run: PipelineRunRecord;
  snapshots: ChapterSnapshotRecord[];
}

/** 启动或续跑指定章的生成管线，返回 commit 后的章节、运行状态与快照（挂起时章节为 null） */
export async function runChapterPipeline(db: DB, llm: LLMProvider, bookId: number, idx: number): Promise<PipelineResult> {
  // API 层已 requireBook；防御性兜底
  if (!getBook(db, bookId)) throw new Error(`书 ${bookId} 不存在（应先由 API 层 404 拦截）`);

  const existing = getRun(db, bookId, idx);
  // 前置校验约束一切「将要执行 prepare」的启动（新启动 / 重新生成 / 无视图续跑）；
  // 断点续跑复用已落盘视图，不受大纲后续漂移影响
  const willPrepare = existing === null || existing.status === 'done' || existing.preparedView === null;
  if (willPrepare) {
    locateApprovedOutline(db, bookId, idx);
  }

  let run = existing;
  if (run === null) {
    createRun(db, bookId, idx);
    run = getRun(db, bookId, idx);
    if (!run) throw new Error('管线状态行创建失败');
  } else if (run.status === 'done') {
    // 重新生成：整条 run 归零重跑
    advanceRun(db, bookId, idx, {
      stage: 'prepare',
      status: 'running',
      attempts: 0,
      error: null,
      preparedView: null,
      draftContent: null,
      fixRounds: 0,
      detectionReport: null,
      semanticReport: null,
    });
    run = getRun(db, bookId, idx)!;
  }

  // ---------- prepare：预算装填构造注入视图（无 LLM 调用） ----------
  let view = run.preparedView;
  if (view === null) {
    try {
      view = buildInjectionView(db, bookId, idx);
    } catch (cause) {
      failRun(db, bookId, idx, run.attempts + 1, 'prepare', cause);
    }
    advanceRun(db, bookId, idx, {
      stage: 'draft',
      status: 'running',
      attempts: run.attempts + 1,
      error: null,
      preparedView: view,
    });
    run = getRun(db, bookId, idx)!;
  }

  // ---------- draft：按 draft 任务路由生成正文草稿 ----------
  if (run.draftContent === null) {
    let produced: string;
    try {
      if (!resolveRoute(db, 'draft')) throw new RouteNotConfiguredError('draft');
      const result = await llm.complete('draft', {
        messages: buildDraftMessages(view),
        temperature: 0.8,
        maxTokens: DRAFT_MAX_TOKENS,
      });
      const content = result.content.trim();
      if (content === '') throw new Error('LLM 返回的正文为空');
      produced = content;
    } catch (cause) {
      failRun(db, bookId, idx, run.attempts + 1, 'draft', cause);
    }
    advanceRun(db, bookId, idx, {
      stage: 'verify',
      status: 'running',
      attempts: run.attempts + 1,
      error: null,
      draftContent: produced,
    });
    run = getRun(db, bookId, idx)!;
  }

  // ---------- verify→fix 闭环：双报告 + 定向重写 + 挂起闸门（详见 pipeline/verify.ts） ----------
  const verdict = await driveVerification(db, llm, bookId, idx);
  if (verdict === 'suspended') {
    return { chapter: null, run: getRun(db, bookId, idx)!, snapshots: [] };
  }

  // ---------- commit：单事务原子落盘 + 落稿事实回灌（回灌失败落盘 extract_error 不阻塞提交） ----------
  return commitWithFactSync(db, llm, bookId, idx);
}

export { deriveSummary };

// ---------- 内部 ----------

/** 前置校验：章 N 必须命中一条已批准（或锁定）的章纲 */
function locateApprovedOutline(db: DB, bookId: number, idx: number): FlatChapter {
  let target: FlatChapter;
  try {
    target = locateChapterOutline(db, bookId, idx);
  } catch (cause) {
    if (cause instanceof PackingRangeError) throw new PipelinePreconditionError(cause.message);
    throw cause;
  }
  const outline = getChapterOutline(db, bookId, target.chapterOutlineId);
  if (outline && (outline.status === 'approved' || outline.status === 'locked')) return target;
  const statusLabel = outline ? OUTLINE_STATUS_LABELS[outline.status] : '不存在';
  throw new PipelinePreconditionError(
    `章 ${idx} 的章纲「${target.chapterTitle}」尚未批准（当前：${statusLabel}），请先批准章纲再启动生成`
  );
}

/** 注入视图 → draft prompt：各层标题为节头，逐条注入文本 */
function buildDraftMessages(view: InjectionView): ChatMessage[] {
  const sections = view.layers
    .filter((layer) => layer.items.length > 0)
    .map((layer) => `【${layer.label}】\n${layer.items.map((item) => item.text).join('\n')}`);
  return [
    { role: 'system', content: DRAFT_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ];
}
