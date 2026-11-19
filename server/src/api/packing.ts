import { Hono } from 'hono';
import { requireBook } from './books';
import type { DB } from '../db/open';
import { DEFAULT_BUDGET_TOKENS, PackingRangeError, buildInjectionView } from '../packing/pack';
import { HttpError } from './errors';
import { parseId, parseQueryInt } from './validate';

/**
 * 第七组路由：注入视图预览（T9）。纯只读计算，无 LLM 依赖：
 * GET /books/:id/packing?chapter=N[&budget=T] → 分层装填清单与 token 账目。
 */
export function packingRoutes(deps: { db: DB }) {
  const app = new Hono();

  app.get('/books/:id/packing', (c) => {
    const { db } = deps;
    const rawId = c.req.param('id') ?? '';
    const bookId = parseId(rawId);
    requireBook(db, bookId, rawId);

    const rawChapter = c.req.query('chapter');
    // 上方已强制必填，parseQueryInt 的 fallback 仅为签名占位
    if (rawChapter === undefined || rawChapter === '') throw new HttpError(400, '参数 chapter：必填');
    const chapter = parseQueryInt(rawChapter, 'chapter', 1, 1_000_000, 1);
    const budget = parseQueryInt(c.req.query('budget'), 'budget', 1, 1_000_000, DEFAULT_BUDGET_TOKENS);

    try {
      return c.json(buildInjectionView(db, bookId, chapter, budget));
    } catch (cause) {
      if (cause instanceof PackingRangeError) throw new HttpError(400, cause.message);
      throw cause;
    }
  });

  return app;
}
