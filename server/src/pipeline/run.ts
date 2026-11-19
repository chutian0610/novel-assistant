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
import {
  advanceRun,
  createRun,
  getChapter,
  getRun,
  insertSnapshot,
  listSnapshots,
  upsertChapter,
  type ChapterRecord,
  type PipelineRunRecord,
  type PipelineStage,
} from './store';

/**
 * 章节管线执行器（T10，ADR-0001 前三阶段）：prepare → draft → commit。
 *
 * 断点续跑契约（spec 用户故事 22）：
 * - 管线状态表 pipeline_runs 按（书，章号）唯一，stage 记录下一个待执行阶段；
 * - 每个阶段的产物先落盘再进入下一阶段：prepare 落注入视图 JSON，draft 落正文草稿；
 * - 重启后续跑时，产物已在的阶段直接跳过——LLM 不重复调用、装填不重复计算；
 * - 失败（LLM 出错/路由未配置/返回空正文）落盘为 failed，可再次调用从断点恢复；
 * - 已 done 的章再次生成 = 全新 run 重跑（覆盖正文并新增 pipeline 快照）。
 *
 * commit 在单事务内原子更新正文与派生物（章节行 + pipeline 快照 + run 终态）。
 * verify/fix 阶段为后续工单，接入后在 draft 与 commit 之间插入同样的「产物落盘」环节。
 */

/** 前置校验失败（章纲缺失/超范围/未批准）——不创建运行记录，API 层映射 409 */
export class PipelinePreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelinePreconditionError';
  }
}

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

/** 单章字数规格（CONTEXT.md「书」：2000-4000 字）对应的上限 */
const DRAFT_MAX_TOKENS = 8192;

/** 滚动摘要上限：V1 为确定性截断摘要（后续工单可换 LLM 摘要并纳入断点续跑） */
const SUMMARY_MAX_CHARS = 200;

const DRAFT_SYSTEM_PROMPT = `你是网文作者。根据给定的书契约、本章大纲、出场角色运行时与相关素材，写出本章正文。要求：
- 只输出正文本身：不要输出章节标题、序号、小标题、说明或任何额外文字。
- 篇幅 2000-4000 字。
- 遵守书契约的题材与基调，按本章大纲推进剧情，人物言行与角色运行时保持一致。`;

export interface PipelineResult {
  chapter: ChapterRecord;
  run: PipelineRunRecord;
  snapshots: ReturnType<typeof listSnapshots>;
}

/** 启动或续跑指定章的生成管线，返回 commit 后的章节、运行状态与快照 */
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
      stage: 'commit',
      status: 'running',
      attempts: run.attempts + 1,
      error: null,
      draftContent: produced,
    });
    run = getRun(db, bookId, idx)!;
  }
  const draft = run.draftContent;
  if (draft === null) throw new Error('draft 产物缺失（断点状态不一致）');

  // ---------- commit：单事务原子落盘（正文 + 版本快照 + run 终态） ----------
  const target = requireChapterOutlineItem(view);
  const summary = deriveSummary(draft);
  const chapterId = db.transaction((): number => {
    const id = upsertChapter(db, bookId, idx, {
      title: target.title,
      outlineId: target.refId,
      content: draft,
      summary,
    });
    insertSnapshot(db, id, draft, summary, 'pipeline');
    advanceRun(db, bookId, idx, { stage: 'done', status: 'done', attempts: run.attempts + 1, error: null });
    touchBook(db, bookId);
    return id;
  })();

  const chapter = getChapter(db, bookId, idx);
  if (!chapter) throw new Error('commit 事务后章节缺失（事务原子性被破坏）');
  const finalRun = getRun(db, bookId, idx)!;
  return { chapter, run: finalRun, snapshots: listSnapshots(db, chapterId) };
}

/** 滚动摘要：压平全部空白后取前 N 字，截断补省略号（content 的确定性派生物） */
export function deriveSummary(content: string): string {
  const flat = content.replace(/\s+/g, '');
  return flat.length <= SUMMARY_MAX_CHARS ? flat : `${flat.slice(0, SUMMARY_MAX_CHARS)}……`;
}

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

function requireChapterOutlineItem(view: InjectionView): { title: string; refId: number | null } {
  const item = view.layers
    .flatMap((layer) => layer.items)
    .find((item) => item.refType === 'chapter-outline');
  if (!item) throw new Error('注入视图缺少章纲条目（buildInjectionView 契约被破坏）');
  return { title: item.title, refId: item.refId };
}

/** 阶段失败统一落盘后抛出：路由未配置原样上抛（API 层 409），其余包装为阶段错误（502） */
function failRun(
  db: DB,
  bookId: number,
  idx: number,
  attempts: number,
  stage: PipelineStage,
  cause: unknown
): never {
  const message = cause instanceof Error ? cause.message : String(cause);
  advanceRun(db, bookId, idx, { stage, status: 'failed', attempts, error: message });
  if (cause instanceof PackingRangeError) throw cause;
  if (cause instanceof RouteNotConfiguredError) throw cause;
  throw new PipelineStageError(stage, `${stage} 阶段失败：${message}`);
}
