import { Hono } from 'hono';
import { z } from 'zod';
import type { DB } from '../db/open';
import {
  MATERIAL_TYPES,
  createMaterial,
  deleteMaterial,
  getMaterial,
  listMaterials,
  listTags,
  updateMaterial,
  type MaterialListFilter,
  type MaterialPayload,
  type MaterialRecord,
  type MaterialType,
} from '../materials/store';
import { HttpError } from './errors';
import { parseBody, parseId, parsePaginationInt, readJson } from './validate';

/**
 * 各类型素材的结构化字段 schema（与 web/src/materialSchema.ts 的表单定义保持镜像同步）。
 * payload 用 .strict()：未知字段直接拒绝，保证各类型 schema 边界清晰。
 */
/** 各类型 payload 的合法键与单字段校验；书内覆写（api/books.ts）按键部分校验复用同一份定义 */
export const payloadFieldSchemas: Record<MaterialType, Record<string, z.ZodString>> = {
  // 设定卡：领域分类（世界观/人物/物品/势力/地点等，自由文本便于扩展）
  setting: { category: z.string().trim().max(100) },
  // 桥段：冲突模式、名场面结构、钩子/反转如何展开
  trope: { structure: z.string().trim().max(5000) },
  // 文风样本：句式节奏说明
  style: { rhythm: z.string().trim().max(5000) },
  // 书骨骼：节奏曲线 / 卷纲结构 / 人物原型（验收必备三字段）
  skeleton: {
    pacingCurve: z.string().trim().min(1, '节奏曲线不能为空').max(10000),
    volumeStructure: z.string().trim().min(1, '卷纲结构不能为空').max(10000),
    archetypes: z.string().trim().min(1, '人物原型不能为空').max(10000),
  },
};

const payloadSchemas: Record<MaterialType, z.ZodType> = {
  setting: z.object(payloadFieldSchemas.setting).strict(),
  trope: z.object(payloadFieldSchemas.trope).strict(),
  style: z.object(payloadFieldSchemas.style).strict(),
  skeleton: z.object(payloadFieldSchemas.skeleton).strict(),
};

// 溯源对象的基础 schema：book/chapter 缺省为空串，随对象整体参与校验
const sourceObject = z.object({
  kind: z.enum(['manual', 'reference']),
  book: z.string().trim().max(200).default(''),
  chapter: z.string().trim().max(200).default(''),
});

interface SourceShape {
  kind: 'manual' | 'reference';
  book: string;
  chapter: string;
}

function withSourceChecks<T extends z.ZodType<SourceShape>>(schema: T): T {
  return schema
    .refine(
      (source) => source.kind === 'manual' || source.book.length > 0,
      '来源为参考书时必须填写来源书名'
    )
    .refine(
      (source) => source.kind === 'reference' || (source.book === '' && source.chapter === ''),
      '人工录入的素材不应填写来源书/章'
    );
}

// 创建：整体缺省时按人工录入处理
const sourceSchema = withSourceChecks(sourceObject).default({ kind: 'manual', book: '', chapter: '' });
// 更新：不带整体默认值——zod v4 中 optional(default) 会在字段缺省时泄漏默认值，破坏「至少一个字段」判断
const sourcePatchSchema = withSourceChecks(sourceObject);

const tagSchema = z.string().trim().min(1, '标签不能为空').max(50, '标签过长');
const tagsSchema = z.array(tagSchema).max(20, '标签最多 20 个');

/** 标题/正文的共享校验规则（书内覆写复用） */
export const materialFieldSchemas = {
  title: z.string().trim().min(1, '标题不能为空').max(200, '标题过长'),
  content: z.string().trim().min(1, '正文不能为空').max(50_000, '正文过长'),
};

const materialFields = {
  title: materialFieldSchemas.title,
  content: materialFieldSchemas.content,
  tags: tagsSchema.default([]),
  source: sourceSchema,
};

/** 设置模块之外的第二组路由：素材库 + 标签聚合 */
export function materialsRoutes(deps: { db: DB }) {
  const { db } = deps;
  const app = new Hono();

  app.get('/materials', (c) => {
    const rawType = c.req.query('type');
    if (rawType !== undefined && rawType !== '' && !(MATERIAL_TYPES as readonly string[]).includes(rawType)) {
      throw new HttpError(400, `未知的素材类型：${rawType}`);
    }
    const filter: MaterialListFilter = {
      type: rawType === '' || rawType === undefined ? undefined : (rawType as MaterialType),
      tag: c.req.query('tag') || undefined,
      q: c.req.query('q') || undefined,
      limit: parsePaginationInt(c.req.query('limit'), 'limit', 1, 200, 50),
      offset: parsePaginationInt(c.req.query('offset'), 'offset', 0, Number.MAX_SAFE_INTEGER, 0),
    };
    const { items, total } = listMaterials(db, filter);
    return c.json({ items: items.map(toMaterialJson), total });
  });

  app.post('/materials', async (c) => {
    const body = await readJson(c);
    const type = parseType(body);
    const data = parseBody(
      z.object({ type: z.literal(type), ...materialFields, payload: payloadSchemas[type] }),
      body
    );
    const record = createMaterial(db, {
      type,
      title: data.title,
      content: data.content,
      payload: data.payload as MaterialPayload,
      tags: data.tags,
      source: data.source,
    });
    return c.json(toMaterialJson(record), 201);
  });

  app.get('/materials/:id', (c) => {
    const record = getMaterial(db, parseId(c.req.param('id')));
    if (!record) throw new HttpError(404, `素材 ${c.req.param('id')} 不存在`);
    return c.json(toMaterialJson(record));
  });

  app.patch('/materials/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    const existing = getMaterial(db, id);
    if (!existing) throw new HttpError(404, `素材 ${id} 不存在`);

    const body = await readJson(c);
    if (body !== null && typeof body === 'object' && 'type' in body) {
      throw new HttpError(400, '素材类型创建后不可修改');
    }
    const data = parseBody(
        z
        .object({
          title: materialFields.title.optional(),
          content: materialFields.content.optional(),
          tags: tagsSchema.optional(),
          source: sourcePatchSchema.optional(),
          payload: z.record(z.string(), z.unknown()).optional(),
        })
        .refine((patch) => Object.keys(patch).length > 0, '至少提供一个要更新的字段'),
      body
    );
    // payload 按素材既有类型细校验（类型不可变）
    const payload =
      data.payload === undefined ? undefined : (parseBody(payloadSchemas[existing.type], data.payload) as MaterialPayload);

    const record = updateMaterial(db, id, {
      title: data.title,
      content: data.content,
      tags: data.tags,
      source: data.source,
      ...(payload === undefined ? {} : { payload }),
    });
    if (!record) throw new HttpError(404, `素材 ${id} 不存在`);
    return c.json(toMaterialJson(record));
  });

  app.delete('/materials/:id', (c) => {
    const deleted = deleteMaterial(db, parseId(c.req.param('id')));
    if (!deleted) throw new HttpError(404, `素材 ${c.req.param('id')} 不存在`);
    return c.body(null, 204);
  });

  app.get('/tags', (c) => {
    return c.json(listTags(db));
  });

  return app;
}

function parseType(body: unknown): MaterialType {
  const raw = (body as { type?: unknown } | null)?.type;
  if (typeof raw !== 'string' || !(MATERIAL_TYPES as readonly string[]).includes(raw)) {
    throw new HttpError(400, `未知的素材类型：${String(raw)}`);
  }
  return raw as MaterialType;
}

/** 素材 JSON 视图（书内引用的 material 字段复用同一形状） */
export function toMaterialJson(record: MaterialRecord) {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    content: record.content,
    payload: record.payload,
    tags: record.tags,
    source: record.source,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
