import { Hono } from 'hono';
import { requireBook } from './books';
import type { DB } from '../db/open';
import { getChapter, listChapterMetrics } from '../pipeline/store';
import { parseId } from './validate';

/**
 * 检测指标趋势路由（T11）。GET /books/:id/metrics →
 * 按章号升序的逐章指标（verify 双报告之一落库；人工编辑/回退后重算），报告页跨章趋势数据源。
 */
export function metricsRoutes(deps: { db: DB }) {
  const { db } = deps;
  const app = new Hono();

  app.get('/books/:id/metrics', (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const items = listChapterMetrics(db, bookId).map((row) => ({
      idx: row.idx,
      title: getChapter(db, bookId, row.idx)?.title ?? null,
      aiScore: row.aiScore,
      confidence: row.confidence,
      adjustedScore: row.adjustedScore,
      wordCount: row.wordCount,
      metrics: row.metrics,
      updatedAt: row.updatedAt,
    }));
    return c.json({ items, total: items.length });
  });

  return app;
}
