import { Hono } from 'hono';
import { z } from 'zod';
import {
  createBook,
  deleteBook,
  getBook,
  getBookMaterial,
  insertBookMaterial,
  listBookMaterials,
  listBooks,
  removeBookMaterial,
  updateBook,
  updateBookMaterial,
  type BookRecord,
  type BookWriteInput,
  type MaterialOverrides,
} from '../books/store';
import type { DB } from '../db/open';
import { getMaterial, type MaterialType } from '../materials/store';
import { HttpError } from './errors';
import { materialFieldSchemas, payloadFieldSchemas } from './materials';
import { parseBody, parseId, parsePaginationInt, readJson } from './validate';

/** 书契约元数据的基础规则；创建时包 default('')，PATCH 时包 optional（不带默认值防泄漏） */
const contractRules = {
  title: z.string().trim().min(1, '书名不能为空').max(200, '书名过长'),
  genre: z.string().trim().max(100, '题材过长'),
  tone: z.string().trim().max(100, '基调过长'),
  promise: z.string().trim().max(2000, '承诺过长'),
};

const bookCreateSchema = z
  .object({
    title: contractRules.title,
    genre: contractRules.genre.default(''),
    tone: contractRules.tone.default(''),
    promise: contractRules.promise.default(''),
  })
  .strict();

const bookPatchSchema = z
  .object({
    title: contractRules.title.optional(),
    genre: contractRules.genre.optional(),
    tone: contractRules.tone.optional(),
    promise: contractRules.promise.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, '至少提供一个要更新的字段');

/**
 * 覆写补丁校验：title/content 复用全局规则；payload 按素材类型的合法键逐键部分校验
 * （覆写是按键补丁，不要求该类型全部字段齐备，合并结果天然合法）。空补丁 = 清除全部覆写。
 */
function parseOverridesPatch(type: MaterialType, body: unknown): MaterialOverrides {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '参数 overrides：应为对象（空对象表示清除全部覆写）');
  }
  const data = parseBody(
    z
      .object({
        title: materialFieldSchemas.title.optional(),
        content: materialFieldSchemas.content.optional(),
        payload: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    body
  );
  const overrides: MaterialOverrides = {};
  if (data.title !== undefined) overrides.title = data.title;
  if (data.content !== undefined) overrides.content = data.content;
  if (data.payload !== undefined) {
    const fields = payloadFieldSchemas[type];
    const payload: Record<string, string> = {};
    for (const [key, value] of Object.entries(data.payload)) {
      const fieldSchema = fields[key];
      if (!fieldSchema) throw new HttpError(400, `参数 payload.${key}：${type} 类素材没有字段 ${key}`);
      const check = fieldSchema.safeParse(value);
      if (!check.success) {
        throw new HttpError(400, `参数 payload.${key}：${check.error.issues[0]?.message ?? '不合法'}`);
      }
      payload[key] = check.data;
    }
    overrides.payload = payload;
  }
  return overrides;
}

/** 路由通用的取书 + 404 前导 */
function requireBook(db: DB, id: number, rawId: string): BookRecord {
  const book = getBook(db, id);
  if (!book) throw new HttpError(404, `书 ${rawId} 不存在`);
  return book;
}

/** 设置与素材之外的第三组路由：书架（书 CRUD）+ 书内素材引用（引用/覆写/移除） */
export function booksRoutes(deps: { db: DB }) {
  const { db } = deps;
  const app = new Hono();

  app.get('/books', (c) => {
    return c.json(
      listBooks(db, {
        limit: parsePaginationInt(c.req.query('limit'), 'limit', 1, 200, 50),
        offset: parsePaginationInt(c.req.query('offset'), 'offset', 0, Number.MAX_SAFE_INTEGER, 0),
      })
    );
  });

  app.post('/books', async (c) => {
    const input: BookWriteInput = parseBody(bookCreateSchema, await readJson(c));
    return c.json(createBook(db, input), 201);
  });

  app.get('/books/:id', (c) => {
    return c.json(requireBook(db, parseId(c.req.param('id')), c.req.param('id')));
  });

  app.patch('/books/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    const book = updateBook(db, id, parseBody(bookPatchSchema, await readJson(c)));
    if (!book) throw new HttpError(404, `书 ${id} 不存在`);
    return c.json(book);
  });

  app.delete('/books/:id', (c) => {
    const id = parseId(c.req.param('id'));
    if (!deleteBook(db, id)) throw new HttpError(404, `书 ${id} 不存在`);
    return c.body(null, 204);
  });

  app.get('/books/:id/materials', (c) => {
    requireBook(db, parseId(c.req.param('id')), c.req.param('id'));
    return c.json(listBookMaterials(db, parseId(c.req.param('id'))));
  });

  app.post('/books/:id/materials', async (c) => {
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));
    const { materialId } = parseBody(
      z.object({ materialId: z.number().int().positive() }).strict(),
      await readJson(c)
    );
    if (!getMaterial(db, materialId)) throw new HttpError(404, `素材 ${materialId} 不存在`);
    if (!insertBookMaterial(db, bookId, materialId)) {
      throw new HttpError(409, `素材 ${materialId} 已引用进本书`);
    }
    return c.json(getBookMaterial(db, bookId, materialId), 201);
  });

  app.patch('/books/:id/materials/:materialId', async (c) => {
    const bookId = parseId(c.req.param('id'));
    const materialId = parseId(c.req.param('materialId'));
    requireBook(db, bookId, c.req.param('id'));
    const material = getMaterial(db, materialId);
    if (!material || !getBookMaterial(db, bookId, materialId)) {
      throw new HttpError(404, `书内不存在素材 ${materialId} 的引用`);
    }
    const { overrides } = parseBody(
      z.object({ overrides: z.unknown() }).strict(),
      await readJson(c)
    );
    if (overrides === undefined) {
      throw new HttpError(400, '参数 overrides：缺失（空对象表示清除全部覆写）');
    }
    return c.json(updateBookMaterial(db, bookId, materialId, parseOverridesPatch(material.type, overrides)));
  });

  app.delete('/books/:id/materials/:materialId', (c) => {
    const bookId = parseId(c.req.param('id'));
    const materialId = parseId(c.req.param('materialId'));
    if (!removeBookMaterial(db, bookId, materialId)) {
      throw new HttpError(404, `书内不存在素材 ${materialId} 的引用`);
    }
    return c.body(null, 204);
  });

  return app;
}
