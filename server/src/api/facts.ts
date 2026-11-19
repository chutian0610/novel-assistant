import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireBook } from './books';
import type { DB } from '../db/open';
import {
  CHARACTER_STATE_CATEGORIES,
  FORESHADOW_STATUSES,
  ForeshadowTransitionError,
  createCharacterRelation,
  createCharacterState,
  createForeshadow,
  createTimelineEvent,
  deleteCharacterRelation,
  deleteCharacterState,
  deleteForeshadow,
  deleteTimelineEvent,
  getForeshadow,
  listCharacterRelations,
  listCharacterStates,
  listForeshadows,
  listTimelineEvents,
  transitionForeshadowStatus,
  updateCharacterRelation,
  updateCharacterState,
  updateForeshadow,
  updateTimelineEvent,
  type CharacterRelationInput,
  type CharacterStateInput,
  type ForeshadowInput,
  type TimelineEventInput,
} from '../facts/store';
import { HttpError } from './errors';
import { parseBody, parseId, parseQueryInt, readJson } from './validate';

const textRules = {
  name: z.string().trim().min(1, '角色名不能为空').max(100, '角色名过长'),
  title: z.string().trim().min(1, '标题不能为空').max(200, '标题过长'),
  relation: z.string().trim().min(1, '关系不能为空').max(200, '关系过长'),
  content: z.string().trim().max(20_000, '内容过长'),
  evidence: z.string().trim().min(1, '原文证据不能为空').max(20_000, '证据过长'),
};

const chapterRule = z.number().int('章号应为整数').min(1, '章号应为正整数').max(1_000_000, '章号过大');

/** PATCH 校验：同一套字段规则的可选化 + 非空守卫 */
function withPatchGuard<T extends z.ZodObject>(schema: T) {
  return schema.partial().refine((patch) => Object.keys(patch).length > 0, '至少提供一个要更新的字段');
}

const characterStateCreateSchema = z
  .object({
    name: textRules.name,
    chapter: chapterRule,
    category: z.enum(CHARACTER_STATE_CATEGORIES),
    content: z.string().trim().min(1, '内容不能为空').max(20_000, '内容过长'),
    evidence: textRules.evidence,
  })
  .strict();
const characterStatePatchSchema = withPatchGuard(characterStateCreateSchema);

const relationCreateSchema = z
  .object({
    fromName: textRules.name,
    toName: textRules.name,
    relation: textRules.relation,
    chapter: chapterRule,
    evidence: textRules.evidence,
  })
  .strict();
const relationPatchSchema = withPatchGuard(relationCreateSchema);

const timelineCreateSchema = z
  .object({
    chapter: chapterRule,
    title: textRules.title,
    content: textRules.content,
    evidence: textRules.evidence,
  })
  .strict();
const timelinePatchSchema = withPatchGuard(timelineCreateSchema);

const foreshadowBaseSchema = z
  .object({
    title: textRules.title,
    content: textRules.content,
    plantedChapter: chapterRule,
    targetChapter: chapterRule,
    evidence: textRules.evidence,
  })
  .strict();
// 创建时校验章序；PATCH 的章序校验需合并现有值，由路由 handler 的 assertChapterOrder 负责
const foreshadowCreateSchema = foreshadowBaseSchema.refine(
  (input) => input.targetChapter >= input.plantedChapter,
  '目标章不能早于埋设章'
);
const foreshadowPatchSchema = withPatchGuard(foreshadowBaseSchema);

const foreshadowStatusSchema = z.object({ status: z.enum(FORESHADOW_STATUSES) }).strict();

/** 伏笔状态迁移错误 → HTTP 409 */
function mapFactError(cause: unknown): unknown {
  if (cause instanceof ForeshadowTransitionError) return new HttpError(409, cause.message);
  return cause;
}

/** 埋设章/目标章的时序守卫：目标章早于埋设章的伏笔会「天生超期」，拒绝登记 */
function assertChapterOrder(plantedChapter: number, targetChapter: number): void {
  if (targetChapter < plantedChapter) throw new HttpError(400, '目标章不能早于埋设章');
}

/**
 * 第六组路由：事实四表（T8，ADR-0002）——角色运行时/人物关系/时间轴/伏笔账本，
 * 全部手动 CRUD（自动回灌后续工单接入），伏笔走状态机 + 超期预警。无 LLM 依赖。
 */
export function factsRoutes(deps: { db: DB }) {
  const { db } = deps;
  const app = new Hono();

  /** 取书 + 404 前导（复用书架路由的 requireBook） */
  function requireBookId(c: Context): number {
    const rawId = c.req.param('id') ?? '';
    const bookId = parseId(rawId);
    requireBook(db, bookId, rawId);
    return bookId;
  }

  /** 事实表数据量小，列表不做分页，统一 { items, total } 响应形状 */
  function listResponse<T>(c: Context, items: T[]) {
    return c.json({ items, total: items.length });
  }

  // ---------- 角色运行时 ----------

  app.get('/books/:id/facts/characters', (c) => {
    const bookId = requireBookId(c);
    return listResponse(c, listCharacterStates(db, bookId));
  });

  app.post('/books/:id/facts/characters', async (c) => {
    const bookId = requireBookId(c);
    const input: CharacterStateInput = parseBody(characterStateCreateSchema, await readJson(c));
    return c.json(createCharacterState(db, bookId, input), 201);
  });

  app.patch('/books/:id/facts/characters/:factId', async (c) => {
    const bookId = requireBookId(c);
    const id = parseId(c.req.param('factId'));
    const patch = parseBody(characterStatePatchSchema, await readJson(c));
    const record = updateCharacterState(db, bookId, id, patch);
    if (!record) throw new HttpError(404, `角色运行时 ${id} 不存在`);
    return c.json(record);
  });

  app.delete('/books/:id/facts/characters/:factId', (c) => {
    const bookId = requireBookId(c);
    if (!deleteCharacterState(db, bookId, parseId(c.req.param('factId')))) {
      throw new HttpError(404, `角色运行时 ${c.req.param('factId')} 不存在`);
    }
    return c.body(null, 204);
  });

  // ---------- 人物关系 ----------

  app.get('/books/:id/facts/relations', (c) => {
    const bookId = requireBookId(c);
    return listResponse(c, listCharacterRelations(db, bookId));
  });

  app.post('/books/:id/facts/relations', async (c) => {
    const bookId = requireBookId(c);
    const input: CharacterRelationInput = parseBody(relationCreateSchema, await readJson(c));
    return c.json(createCharacterRelation(db, bookId, input), 201);
  });

  app.patch('/books/:id/facts/relations/:factId', async (c) => {
    const bookId = requireBookId(c);
    const id = parseId(c.req.param('factId'));
    const patch = parseBody(relationPatchSchema, await readJson(c));
    const record = updateCharacterRelation(db, bookId, id, patch);
    if (!record) throw new HttpError(404, `人物关系 ${id} 不存在`);
    return c.json(record);
  });

  app.delete('/books/:id/facts/relations/:factId', (c) => {
    const bookId = requireBookId(c);
    if (!deleteCharacterRelation(db, bookId, parseId(c.req.param('factId')))) {
      throw new HttpError(404, `人物关系 ${c.req.param('factId')} 不存在`);
    }
    return c.body(null, 204);
  });

  // ---------- 时间轴 ----------

  app.get('/books/:id/facts/timeline', (c) => {
    const bookId = requireBookId(c);
    return listResponse(c, listTimelineEvents(db, bookId));
  });

  app.post('/books/:id/facts/timeline', async (c) => {
    const bookId = requireBookId(c);
    const input: TimelineEventInput = parseBody(timelineCreateSchema, await readJson(c));
    return c.json(createTimelineEvent(db, bookId, input), 201);
  });

  app.patch('/books/:id/facts/timeline/:factId', async (c) => {
    const bookId = requireBookId(c);
    const id = parseId(c.req.param('factId'));
    const patch = parseBody(timelinePatchSchema, await readJson(c));
    const record = updateTimelineEvent(db, bookId, id, patch);
    if (!record) throw new HttpError(404, `时间轴事件 ${id} 不存在`);
    return c.json(record);
  });

  app.delete('/books/:id/facts/timeline/:factId', (c) => {
    const bookId = requireBookId(c);
    if (!deleteTimelineEvent(db, bookId, parseId(c.req.param('factId')))) {
      throw new HttpError(404, `时间轴事件 ${c.req.param('factId')} 不存在`);
    }
    return c.body(null, 204);
  });

  // ---------- 伏笔账本 ----------

  app.get('/books/:id/facts/foreshadows', (c) => {
    const bookId = requireBookId(c);
    const raw = c.req.query('currentChapter');
    // 指定当前章时逐条判定超期预警；非法值 400 由 parseQueryInt 统一处理
    const currentChapter = raw === undefined || raw === '' ? undefined : parseQueryInt(raw, 'currentChapter', 1, 1_000_000, 0);
    return listResponse(c, listForeshadows(db, bookId, currentChapter));
  });

  app.post('/books/:id/facts/foreshadows', async (c) => {
    const bookId = requireBookId(c);
    const input: ForeshadowInput = parseBody(foreshadowCreateSchema, await readJson(c));
    const record = createForeshadow(db, bookId, input);
    if (!record) throw new HttpError(404, `书 ${bookId} 不存在`);
    return c.json(record, 201);
  });

  app.patch('/books/:id/facts/foreshadows/:factId', async (c) => {
    const bookId = requireBookId(c);
    const id = parseId(c.req.param('factId'));
    const patch = parseBody(foreshadowPatchSchema, await readJson(c));
    const existing = getForeshadow(db, bookId, id);
    if (!existing) throw new HttpError(404, `伏笔 ${id} 不存在`);
    assertChapterOrder(patch.plantedChapter ?? existing.plantedChapter, patch.targetChapter ?? existing.targetChapter);
    return c.json(updateForeshadow(db, bookId, id, patch)!);
  });

  app.delete('/books/:id/facts/foreshadows/:factId', (c) => {
    const bookId = requireBookId(c);
    if (!deleteForeshadow(db, bookId, parseId(c.req.param('factId')))) {
      throw new HttpError(404, `伏笔 ${c.req.param('factId')} 不存在`);
    }
    return c.body(null, 204);
  });

  app.post('/books/:id/facts/foreshadows/:factId/status', async (c) => {
    try {
      const bookId = requireBookId(c);
      const id = parseId(c.req.param('factId'));
      const { status } = parseBody(foreshadowStatusSchema, await readJson(c));
      const record = transitionForeshadowStatus(db, bookId, id, status);
      if (!record) throw new HttpError(404, `伏笔 ${id} 不存在`);
      return c.json(record);
    } catch (cause) {
      throw mapFactError(cause);
    }
  });

  return app;
}
