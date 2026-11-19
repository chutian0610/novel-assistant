import { Hono } from 'hono';
import { z } from 'zod';
import { requireBook } from './books';
import type { DB } from '../db/open';
import { resolveRoute } from '../llm/resolver';
import { RouteNotConfiguredError } from '../llm/routed';
import type { LLMProvider } from '../llm/types';
import { expandChapterOutline, OutlineParseError } from '../outlines/expand';
import {
  createChapterOutline,
  createVolume,
  deleteChapterOutline,
  deleteVolume,
  getChapterOutline,
  getOutlineTree,
  OUTLINE_STATUSES,
  OutlineLockedError,
  OutlineTransitionError,
  transitionChapterOutlineStatus,
  updateChapterOutline,
  updateVolume,
  type OutlineWriteInput,
} from '../outlines/store';
import { HttpError } from './errors';
import { parseBody, parseId, readJson } from './validate';

const textRules = {
  title: z.string().trim().min(1, '标题不能为空').max(200, '标题过长'),
  summary: z.string().trim().max(20_000, '概述过长'),
};

// 卷纲与章纲的写入形状相同（标题 + 概述），共用一套校验
const outlineCreateSchema = z.object({ title: textRules.title, summary: textRules.summary.default('') }).strict();
const outlinePatchSchema = z
  .object({ title: textRules.title.optional(), summary: textRules.summary.optional() })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, '至少提供一个要更新的字段');

const statusSchema = z.object({ status: z.enum(OUTLINE_STATUSES) }).strict();

const expandSchema = z.object({ hint: z.string().trim().max(2000, '作者要求过长').optional() }).strict();

/** 大纲服务错误 → HTTP 的统一映射：锁定/非法迁移/路由未配置 → 409，LLM 产出不合法 → 502 */
function mapOutlineError(cause: unknown): unknown {
  if (cause instanceof OutlineLockedError) return new HttpError(409, cause.message);
  if (cause instanceof OutlineTransitionError) return new HttpError(409, cause.message);
  if (cause instanceof RouteNotConfiguredError) return new HttpError(409, cause.message);
  if (cause instanceof OutlineParseError) return new HttpError(502, cause.message);
  return cause;
}

/** 第五组路由：两级大纲（卷纲/章纲 CRUD + 状态机 + 章纲 AI 多方案展开），LLM 走 outline 任务路由 */
export function outlinesRoutes(deps: { db: DB; llm: LLMProvider }) {
  const { db, llm } = deps;
  const app = new Hono();

  // ---------- 大纲树 ----------

  app.get('/books/:id/outlines', (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    return c.json(getOutlineTree(db, bookId));
  });

  // ---------- 卷纲 ----------

  app.post('/books/:id/outlines/volumes', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const input: OutlineWriteInput = parseBody(outlineCreateSchema, await readJson(c));
    const volume = createVolume(db, bookId, input);
    if (!volume) throw new HttpError(404, `书 ${bookId} 不存在`);
    return c.json(volume, 201);
  });

  app.patch('/books/:id/outlines/volumes/:volumeId', async (c) => {
    const bookId = parseId(c.req.param('id'));
    const volumeId = parseId(c.req.param('volumeId'));
    const input = parseBody(outlinePatchSchema, await readJson(c));
    const volume = updateVolume(db, bookId, volumeId, input);
    if (!volume) throw new HttpError(404, `卷纲 ${volumeId} 不存在`);
    return c.json(volume);
  });

  app.delete('/books/:id/outlines/volumes/:volumeId', (c) => {
    const bookId = parseId(c.req.param('id'));
    const volumeId = parseId(c.req.param('volumeId'));
    try {
      if (!deleteVolume(db, bookId, volumeId)) throw new HttpError(404, `卷纲 ${volumeId} 不存在`);
    } catch (cause) {
      throw mapOutlineError(cause);
    }
    return c.body(null, 204);
  });

  // ---------- 章纲 ----------

  app.post('/books/:id/outlines/volumes/:volumeId/chapters', async (c) => {
    const bookId = parseId(c.req.param('id'));
    const volumeId = parseId(c.req.param('volumeId'));
    const input: OutlineWriteInput = parseBody(outlineCreateSchema, await readJson(c));
    const chapter = createChapterOutline(db, bookId, volumeId, input);
    if (!chapter) throw new HttpError(404, `卷纲 ${volumeId} 不存在`);
    return c.json(chapter, 201);
  });

  app.patch('/books/:id/outlines/chapters/:chapterId', async (c) => {
    const bookId = parseId(c.req.param('id'));
    const chapterId = parseId(c.req.param('chapterId'));
    const input = parseBody(outlinePatchSchema, await readJson(c));
    try {
      const chapter = updateChapterOutline(db, bookId, chapterId, input);
      if (!chapter) throw new HttpError(404, `章纲 ${chapterId} 不存在`);
      return c.json(chapter);
    } catch (cause) {
      throw mapOutlineError(cause);
    }
  });

  app.delete('/books/:id/outlines/chapters/:chapterId', (c) => {
    const bookId = parseId(c.req.param('id'));
    const chapterId = parseId(c.req.param('chapterId'));
    try {
      if (!deleteChapterOutline(db, bookId, chapterId)) throw new HttpError(404, `章纲 ${chapterId} 不存在`);
    } catch (cause) {
      throw mapOutlineError(cause);
    }
    return c.body(null, 204);
  });

  app.post('/books/:id/outlines/chapters/:chapterId/status', async (c) => {
    const bookId = parseId(c.req.param('id'));
    const chapterId = parseId(c.req.param('chapterId'));
    const { status } = parseBody(statusSchema, await readJson(c));
    try {
      const chapter = transitionChapterOutlineStatus(db, bookId, chapterId, status);
      if (!chapter) throw new HttpError(404, `章纲 ${chapterId} 不存在`);
      return c.json(chapter);
    } catch (cause) {
      throw mapOutlineError(cause);
    }
  });

  // ---------- 章纲 AI 多方案展开 ----------

  app.post('/books/:id/outlines/chapters/:chapterId/expansions', async (c) => {
    try {
      const bookId = parseId(c.req.param('id'));
      const chapterId = parseId(c.req.param('chapterId'));
      const { hint } = parseBody(expandSchema, await readJson(c));
      const book = requireBook(db, bookId, c.req.param('id'));
      const chapter = getChapterOutline(db, bookId, chapterId);
      if (!chapter) throw new HttpError(404, `章纲 ${chapterId} 不存在`);

      // 前导校验路由（与拆书提取一致），再定位章所在卷与叙事序号
      if (!resolveRoute(db, 'outline')) throw new RouteNotConfiguredError('outline');
      const tree = getOutlineTree(db, bookId);
      const volumeIndex = tree.volumes.findIndex((volume) => volume.id === chapter.volumeId);
      if (volumeIndex === -1) throw new HttpError(404, `章纲 ${chapterId} 所属卷不存在`);
      const volumeWithChapters = tree.volumes[volumeIndex]!;
      const chapterIndex = volumeWithChapters.chapters.findIndex((item) => item.id === chapter.id);
      const priorChapters = tree.volumes.slice(0, volumeIndex).reduce((sum, volume) => sum + volume.chapters.length, 0);

      const result = await expandChapterOutline(llm, {
        book,
        volume: volumeWithChapters,
        chapter,
        volumeOrdinal: volumeIndex + 1,
        chapterOrdinal: priorChapters + chapterIndex + 1,
        hint,
      });
      return c.json(result);
    } catch (cause) {
      throw mapOutlineError(cause);
    }
  });

  return app;
}
