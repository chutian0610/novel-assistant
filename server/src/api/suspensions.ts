import { Hono } from 'hono';
import { z } from 'zod';
import { requireBook } from './books';
import type { DB } from '../db/open';
import { RouteNotConfiguredError } from '../llm/routed';
import type { LLMProvider } from '../llm/types';
import {
  getChapter,
  getChapterId,
  getRun,
  getSuspension,
  listSuspensions,
  PIPELINE_STATUS_LABELS,
  type SuspensionRecord,
} from '../pipeline/store';
import { resolveFromSuspension, rewriteFromSuspension, PipelineStageError } from '../pipeline/verify';
import { HttpError } from './errors';
import { parseBody, parseId, readJson } from './validate';

const resolveSchema = z
  .object({ resolution: z.enum(['ignore', 'fact']) })
  .strict();

/** 挂起队列动作错误 → HTTP 的统一映射：路由未配置 409，阶段失败 502，未知错误交全局中间件 */
function mapSuspensionError(cause: unknown): unknown {
  if (cause instanceof RouteNotConfiguredError) return new HttpError(409, cause.message);
  if (cause instanceof PipelineStageError) return new HttpError(502, cause.message);
  return cause;
}

/** 挂起队列动作的统一响应：运行状态 + 可能已 commit 的章节 + 剩余 pending 项 */
interface SuspensionActionResult {
  run: ReturnType<typeof getRun>;
  chapter: ReturnType<typeof getChapter>;
  suspensions: SuspensionRecord[];
}

/** 挂起队列路由（T11）——列出挂起项，一键重写（定向重写一轮后复检）与一键裁决（忽略/修事实）。 */
export function suspensionsRoutes(deps: { db: DB; llm: LLMProvider }) {
  const { db, llm } = deps;
  const app = new Hono();

  app.get('/books/:id/suspensions', (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const pendingOnly = c.req.query('status') === 'pending';
    const idxRaw = c.req.query('idx');
    const idx = idxRaw === undefined || idxRaw === '' ? undefined : parseId(idxRaw);
    const items = listSuspensions(db, bookId, { pendingOnly, idx });
    return c.json({ items, total: items.length });
  });

  app.post('/books/:id/chapters/:idx/suspensions/:sid/rewrite', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const idx = parseId(c.req.param('idx'));
    const sid = parseId(c.req.param('sid'));
    const item = requirePendingItem(db, bookId, idx, sid);
    try {
      await rewriteFromSuspension(db, llm, bookId, idx, item);
      return c.json(toActionResult(db, bookId, idx));
    } catch (cause) {
      throw mapSuspensionError(cause);
    }
  });

  app.post('/books/:id/chapters/:idx/suspensions/:sid/resolve', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const idx = parseId(c.req.param('idx'));
    const sid = parseId(c.req.param('sid'));
    const item = requirePendingItem(db, bookId, idx, sid);
    const { resolution } = parseBody(resolveSchema, await readJson(c));
    try {
      await resolveFromSuspension(db, llm, bookId, idx, item, resolution);
      return c.json(toActionResult(db, bookId, idx));
    } catch (cause) {
      throw mapSuspensionError(cause);
    }
  });

  return app;
}

// ---------- 内部 ----------

function requirePendingItem(db: DB, bookId: number, idx: number, sid: number): SuspensionRecord {
  if (getRun(db, bookId, idx) === null) throw new HttpError(404, `书 ${bookId} 还没有第 ${idx} 章的生成记录`);
  const item = getSuspension(db, bookId, idx, sid);
  if (!item) throw new HttpError(404, `第 ${idx} 章不存在挂起项 ${sid}`);
  if (item.status !== 'pending') throw new HttpError(409, `挂起项 ${sid} 已处理（${item.resolution}）`);
  const run = getRun(db, bookId, idx)!;
  if (run.status !== 'suspended') {
    throw new HttpError(409, `第 ${idx} 章的管线不在挂起状态（当前：${PIPELINE_STATUS_LABELS[run.status]}）`);
  }
  return item;
}

function toActionResult(db: DB, bookId: number, idx: number): SuspensionActionResult {
  const run = getRun(db, bookId, idx);
  const chapterId = getChapterId(db, bookId, idx);
  const chapter = chapterId === null ? null : getChapter(db, bookId, idx);
  return {
    run,
    chapter,
    suspensions: listSuspensions(db, bookId, { idx, pendingOnly: true }),
  };
}
