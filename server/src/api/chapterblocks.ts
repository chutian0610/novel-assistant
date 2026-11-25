import { Hono } from 'hono';
import type { DB } from '../db/open';
import { embedRouteModel, reindexChapterBlockEmbeddings } from '../embeddings/store';
import type { LLMProvider } from '../llm/types';
import { findSimilarPairs } from '../chapterblocks/similarity';
import { requireBook } from './books';
import { HttpError } from './errors';
import { parseId } from './validate';

/**
 * 第九组路由：正文块向量（T19 管道 / T20 自相似报告）。
 * POST /books/:id/chapter-blocks/reindex   书级重建（补缺失 / 换模型 stale；无路由 409）
 * GET  /books/:id/similarity               跨章情节自相似报告（纯向量扫描，无 LLM 调用）
 * （呼应检索端点由 T21 加入本组）
 */
export function chapterBlockRoutes(deps: { db: DB; llm: LLMProvider }) {
  const { db, llm } = deps;
  const app = new Hono();

  app.post('/books/:id/chapter-blocks/reindex', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    if (!embedRouteModel(db)) {
      throw new HttpError(409, '尚未配置 embed 模型路由，无法建立正文向量索引');
    }
    const outcome = await reindexChapterBlockEmbeddings(db, llm, bookId);
    return c.json(outcome);
  });

  app.get('/books/:id/similarity', (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    return c.json(findSimilarPairs(db, bookId));
  });

  return app;
}
