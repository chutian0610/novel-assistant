import { Hono } from 'hono';
import { z } from 'zod';
import type { DB } from '../db/open';
import { embedRouteModel, reindexChapterBlockEmbeddings } from '../embeddings/store';
import type { LLMProvider } from '../llm/types';
import { findSimilarPairs, searchChapterBlocks } from '../chapterblocks/similarity';
import { requireBook } from './books';
import { HttpError } from './errors';
import { parseBody, parseId, readJson } from './validate';

const MAX_SEARCH_TOP_K = 50;

/**
 * 第九组路由：正文块向量（T19 管道 / T20 自相似报告 / T21 呼应检索）。
 * POST /books/:id/chapter-blocks/reindex   书级重建（补缺失 / 换模型 stale；无路由 409）
 * GET  /books/:id/similarity               跨章情节自相似报告（纯向量扫描，无 LLM 调用）
 * POST /books/:id/chapter-blocks/search    呼应检索：查询句 → 全书相似旧段 top-K
 */
export function chapterBlockRoutes(deps: { db: DB; llm: LLMProvider }) {
  const { db, llm } = deps;
  const app = new Hono();

  const searchSchema = z
    .object({
      query: z.string().trim().min(1, '查询内容不能为空').max(2000, '查询内容过长'),
      excludeIdx: z.number().int().min(1).optional(),
      topK: z.number().int().min(1).max(MAX_SEARCH_TOP_K).optional(),
    })
    .strict();

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

  app.post('/books/:id/chapter-blocks/search', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    if (!embedRouteModel(db)) {
      throw new HttpError(409, '尚未配置 embed 模型路由，呼应检索不可用');
    }
    const body = parseBody(searchSchema, await readJson(c));
    try {
      return c.json(await searchChapterBlocks(db, llm, bookId, { query: body.query, excludeIdx: body.excludeIdx, topK: body.topK ?? 10 }));
    } catch (cause) {
      // 查询嵌入失败：路由在但服务不通（与连通测试的 ok:false 同口径）
      throw new HttpError(502, `嵌入服务调用失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });

  return app;
}
