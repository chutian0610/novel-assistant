import { Hono } from 'hono';
import type { DB } from '../db/open';
import type { LLMProvider } from '../llm/types';
import { getRun } from '../pipeline/store';
import { settleFactSync } from '../pipeline/verify';
import { analyzeChapter } from '../radar/analyze';
import { getDepressionWarning, getRadarSummary } from '../radar/store';
import { requireBook } from './books';
import { HttpError } from './errors';
import { parseId } from './validate';

/**
 * 第八组路由：爽点雷达（T18，观测与预警维度——不进重写闸门、不挂起）。
 * GET  /books/:id/radar             按章聚合的爽点标注 + 钩子评级 + 连续压抑预警
 * POST /books/:id/chapters/:idx/radar   手动重灌单章评测（镜像事实回灌端点语义）
 */
export function radarRoutes(deps: { db: DB; llm: LLMProvider }) {
  const { db, llm } = deps;
  const app = new Hono();

  app.get('/books/:id/radar', (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    return c.json({ items: getRadarSummary(db, bookId), warning: getDepressionWarning(db, bookId) });
  });

  // 手动重灌（T18）：仅对已落稿章节开放。评测是 commit 旁路：catch-all 落 radarError
  // 返回 200 而非走 500 范式，与「失败不阻塞、可重试」语义一致（编程错误同样可经重试暴露）
  app.post('/books/:id/chapters/:idx/radar', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const idx = parseId(c.req.param('idx'));
    const run = getRun(db, bookId, idx);
    if (!run || run.status !== 'done') {
      throw new HttpError(404, `书 ${bookId} 还没有已落稿的第 ${idx} 章`);
    }
    let message: string | null = null;
    try {
      await analyzeChapter(db, llm, bookId, idx);
    } catch (cause) {
      message = `爽点回灌失败：${cause instanceof Error ? cause.message : String(cause)}`;
    }
    // 保留既有 extractError，仅更新雷达旁路结果
    const settled = settleFactSync(db, bookId, idx, run.attempts, run.extractError, message);
    return c.json({
      run: settled,
      radar: getRadarSummary(db, bookId).find((item) => item.idx === idx) ?? null,
      error: message,
    });
  });

  return app;
}
