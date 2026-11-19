import { Hono } from 'hono';
import { z } from 'zod';
import { requireBook } from './books';
import type { DB } from '../db/open';
import { RouteNotConfiguredError } from '../llm/routed';
import type { LLMProvider } from '../llm/types';
import { PackingRangeError } from '../packing/pack';
import { deriveSummary, PipelinePreconditionError, PipelineStageError, runChapterPipeline } from '../pipeline/run';
import {
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
  type PipelineRunRecord,
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

/** 章节列表项：章节 + 运行状态摘要（不带注入视图等重负载） */
export interface ChapterListItem {
  idx: number;
  title: string;
  outlineId: number | null;
  summary: string;
  charCount: number;
  createdAt: string;
  updatedAt: string;
  run: Pick<PipelineRunRecord, 'stage' | 'status' | 'attempts' | 'error'> | null;
}

/**
 * 第六组路由：章节管线与写作台（T10）。
 * POST /books/:id/chapters/:idx/generate 启动/续跑 prepare→draft→commit；
 * GET 列表与详情、PATCH 编辑正文、POST revert 回退快照。verify/fix 为后续工单。
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
        run: run ? { stage: run.stage, status: run.status, attempts: run.attempts, error: run.error } : null,
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
    })();
    return c.json(getChapter(db, bookId, idx));
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
    })();
    return c.json(getChapter(db, bookId, idx));
  });

  return app;
}

// ---------- 内部 ----------

/** 正文写入守卫：管线未完成（running/failed）时拒绝编辑与回退，避免续跑覆盖人工修改 */
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
