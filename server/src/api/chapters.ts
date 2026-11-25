import { Hono } from 'hono';
import { z } from 'zod';
import { requireBook } from './books';
import { getDetectorConfig } from '../detectors/config';
import { analyzeText } from '../detectors/metrics';
import type { DB } from '../db/open';
import { deleteAutoFacts } from '../facts/store';
import { extractFacts } from '../facts/extract-facts';
import { RouteNotConfiguredError } from '../llm/routed';
import type { LLMProvider } from '../llm/types';
import { PackingRangeError } from '../packing/pack';
import { getPipelineConfig } from '../pipeline/config';
import { getPipelineQueue, runBatch } from '../pipeline/batch';
import { deriveSummary, PipelinePreconditionError, runChapterPipeline } from '../pipeline/run';
import { PipelineStageError, settleFactSync } from '../pipeline/verify';
import {
  advanceRun,
  getChapter,
  getChapterId,
  getRun,
  getSnapshot,
  insertSnapshot,
  listChapters,
  listSnapshots,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STATUS_LABELS,
  updateChapterContent,
  upsertChapterMetrics,
  toCompactRun,
  type CompactRun,
} from '../pipeline/store';
import { HttpError } from './errors';
import { parseBody, parseId, readJson } from './validate';

/** 章节编辑：正文非空（派生摘要与快照都以此为准） */
const chapterPatchSchema = z
  .object({ content: z.string().trim().min(1, '正文不能为空').max(500_000, '正文过长') })
  .strict();

const revertSchema = z.object({ snapshotId: z.number().int().positive() }).strict();

/** 管线相关错误 → HTTP 的统一映射：范围外 400，前置/路由 409，阶段失败 502 */
function mapPipelineError(cause: unknown): unknown {
  if (cause instanceof PackingRangeError) return new HttpError(400, cause.message);
  if (cause instanceof PipelinePreconditionError) return new HttpError(409, cause.message);
  if (cause instanceof RouteNotConfiguredError) return new HttpError(409, cause.message);
  if (cause instanceof PipelineStageError) return new HttpError(502, cause.message);
  return cause;
}

/** 章节列表项：章节 + 运行状态摘要（CompactRun 统一投影，不带注入视图等重负载） */
export interface ChapterListItem {
  idx: number;
  title: string;
  outlineId: number | null;
  summary: string;
  charCount: number;
  createdAt: string;
  updatedAt: string;
  run: CompactRun | null;
}

/**
 * 章节管线与写作台路由（T10 骨架 + T11 闭环）。
 * POST /books/:id/chapters/:idx/generate 启动/续跑 prepare→draft→verify→fix→commit
 * （闸门未过时挂起，经挂起队列裁决后由 rewrite/resolve 续跑）；
 * GET 列表与详情、PATCH 编辑正文（指标派生物同步重算）、POST revert 回退快照。
 */
export function chaptersRoutes(deps: { db: DB; llm: LLMProvider }) {
  const { db, llm } = deps;
  const app = new Hono();

  app.get('/books/:id/chapters', (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const items: ChapterListItem[] = listChapters(db, bookId).map((chapter) => {
      const run = getRun(db, bookId, chapter.idx);
      return {
        idx: chapter.idx,
        title: chapter.title,
        outlineId: chapter.outlineId,
        summary: chapter.summary,
        charCount: chapter.charCount,
        createdAt: chapter.createdAt,
        updatedAt: chapter.updatedAt,
        run: run ? toCompactRun(run) : null,
      };
    });
    return c.json({ items, total: items.length });
  });

  app.post('/books/:id/chapters/:idx/generate', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const idx = parseId(c.req.param('idx'));
    try {
      return c.json(await runChapterPipeline(db, llm, bookId, idx));
    } catch (cause) {
      throw mapPipelineError(cause);
    }
  });

  app.get('/books/:id/chapters/:idx', (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const idx = parseId(c.req.param('idx'));
    const chapterId = getChapterId(db, bookId, idx);
    const chapter = getChapter(db, bookId, idx);
    if (chapterId === null || !chapter) throw new HttpError(404, `书 ${bookId} 还没有第 ${idx} 章`);
    return c.json({ chapter, run: getRun(db, bookId, idx), snapshots: listSnapshots(db, chapterId) });
  });

  app.patch('/books/:id/chapters/:idx', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const idx = parseId(c.req.param('idx'));
    const { content } = parseBody(chapterPatchSchema, await readJson(c));
    const chapterId = getChapterId(db, bookId, idx);
    if (chapterId === null) throw new HttpError(404, `书 ${bookId} 还没有第 ${idx} 章`);
    assertRunSettled(db, bookId, idx);

    const summary = deriveSummary(content);
    db.transaction(() => {
      updateChapterContent(db, bookId, idx, content, summary);
      insertSnapshot(db, chapterId, content, summary, 'edit');
      // 旧稿的回灌事实随正文失效而清除（溯源不断裂），经「重新回灌」以新稿重建
      deleteAutoFacts(db, bookId, idx);
    })();
    // 指标派生物同步重算（纯检测，不走 LLM；语义报告随下次 verify 刷新）
    const detection = analyzeText(content, getDetectorConfig(db));
    upsertChapterMetrics(db, bookId, idx, {
      aiScore: detection.aiScore,
      confidence: detection.confidence,
      adjustedScore: detection.adjustedScore,
      wordCount: detection.wordCount,
      metrics: detection.metrics,
    });
    return c.json(getChapter(db, bookId, idx));
  });

  // ---------- 全自动连跑与批量队列视图（T13，ADR-0001 全自动预设） ----------

  // 连跑：协作预设拒绝（逐章审阅语义）；从第一个未完成章连续生成至上限后暂停待审
  app.post('/books/:id/chapters/batch-generate', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const config = getPipelineConfig(db);
    if (config.mode !== 'auto') {
      throw new HttpError(
        409,
        '当前为协作预设（逐章审阅）：生成一章审一章，连跑仅在全自动预设下开放；可在设置中切换预设'
      );
    }
    return c.json(await runBatch(db, llm, bookId, config));
  });

  // 批量队列视图：大纲树全位置 ⋈ 运行状态（含挂起/失败等未落稿断点），实时可见
  app.get('/books/:id/pipeline-queue', (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    return c.json({ items: getPipelineQueue(db, bookId) });
  });

  // 手动事实回灌（T12）：回灌失败后的重试入口；仅对已落稿章节开放。
  // 回灌是 commit 旁路：此处 catch-all 落 extractError 返回 200 而非走 500 范式，
  // 与 commitWithFactSync 的「失败不阻塞、可重试」语义保持一致（编程错误同样可经重试暴露）
  app.post('/books/:id/chapters/:idx/extract', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const idx = parseId(c.req.param('idx'));
    const run = getRun(db, bookId, idx);
    if (!run || run.status !== 'done' || !getChapter(db, bookId, idx)) {
      throw new HttpError(404, `书 ${bookId} 还没有已落稿的第 ${idx} 章`);
    }
    let message: string | null = null;
    let facts: unknown = null;
    try {
      facts = await extractFacts(db, llm, bookId, idx);
    } catch (cause) {
      message = `事实回灌失败：${cause instanceof Error ? cause.message : String(cause)}`;
    }
    return c.json({ run: settleFactSync(db, bookId, idx, run.attempts, message, run.radarError), facts });
  });

  app.post('/books/:id/chapters/:idx/revert', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const idx = parseId(c.req.param('idx'));
    const { snapshotId } = parseBody(revertSchema, await readJson(c));
    const chapterId = getChapterId(db, bookId, idx);
    if (chapterId === null) throw new HttpError(404, `书 ${bookId} 还没有第 ${idx} 章`);
    assertRunSettled(db, bookId, idx);
    const snapshot = getSnapshot(db, chapterId, snapshotId);
    if (!snapshot) throw new HttpError(404, `第 ${idx} 章不存在快照 ${snapshotId}`);

    db.transaction(() => {
      updateChapterContent(db, bookId, idx, snapshot.content, snapshot.summary);
      insertSnapshot(db, chapterId, snapshot.content, snapshot.summary, 'revert');
      // 同编辑：回退后旧稿回灌事实清除，可经「重新回灌」重建
      deleteAutoFacts(db, bookId, idx);
    })();
    // 指标派生物跟随正文重算（与编辑同规则：纯检测，不走 LLM）
    const detection = analyzeText(snapshot.content, getDetectorConfig(db));
    upsertChapterMetrics(db, bookId, idx, {
      aiScore: detection.aiScore,
      confidence: detection.confidence,
      adjustedScore: detection.adjustedScore,
      wordCount: detection.wordCount,
      metrics: detection.metrics,
    });
    return c.json(getChapter(db, bookId, idx));
  });

  return app;
}

// ---------- 内部 ----------

/** 正文写入守卫：管线未完成（running/failed/suspended）时拒绝编辑与回退，避免续跑覆盖人工修改 */
function assertRunSettled(db: DB, bookId: number, idx: number): void {
  const run = getRun(db, bookId, idx);
  if (run && run.status !== 'done') {
    throw new HttpError(
      409,
      `第 ${idx} 章的生成管线未完成（阶段：${PIPELINE_STAGE_LABELS[run.stage]}，状态：${PIPELINE_STATUS_LABELS[run.status]}），` +
        '请先完成或重新生成，再编辑正文'
    );
  }
}
