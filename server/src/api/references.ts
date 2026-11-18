import { Hono } from 'hono';
import { z } from 'zod';
import { runExtraction } from '../references/extract';
import { decodeReferenceText, parseEpub, splitTxtChapters } from '../references/split';
import {
  archiveExtractionItem,
  deleteReference,
  findConflictMaterial,
  getExtractionItem,
  getReference,
  getReferenceTitle,
  listExtractionItems,
  listReferences,
  updateExtractionItem,
  createReference,
  type ExtractionStatus,
} from '../references/store';
import { createMaterial, getMaterial, updateMaterial, type MaterialSource } from '../materials/store';
import { RouteNotConfiguredError } from '../llm/routed';
import type { DB } from '../db/open';
import type { LLMProvider } from '../llm/types';
import { HttpError } from './errors';
import { parseMaterialFieldPatch } from './material-patch';
import { parseBody, parseId, readJson } from './validate';

const MAX_TXT_BYTES = 5 * 1024 * 1024;
const MAX_EPUB_BYTES = 50 * 1024 * 1024;
const EXTRACTION_STATUSES = ['pending', 'accepted', 'rejected'] as const;

/** 第四组路由：拆书提取（上传/分章 → 逐章抽取 → 确认队列 → 入库），LLM 走 extract 任务路由 */
export function referencesRoutes(deps: { db: DB; llm: LLMProvider }) {
  const { db, llm } = deps;
  const app = new Hono();

  // ---------- 参考书 ----------

  app.post('/references', async (c) => {
    const format = c.req.query('format');
    if (format !== 'txt' && format !== 'epub') throw new HttpError(400, '参数 format：应为 txt 或 epub');
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length === 0) throw new HttpError(400, '上传内容为空');
    const maxBytes = format === 'txt' ? MAX_TXT_BYTES : MAX_EPUB_BYTES;
    if (bytes.length > maxBytes) throw new HttpError(413, `文件超过大小上限（${format === 'txt' ? '5MB' : '50MB'}）`);

    let title = (c.req.query('title') ?? '').trim();
    let text: string;
    if (format === 'txt') {
      if (title === '') throw new HttpError(400, '参数 title：txt 上传必须提供书名');
      if (title.length > 200) throw new HttpError(400, '参数 title：书名过长');
      text = decodeReferenceText(bytes);
    } else {
      try {
        const parsed = parseEpub(bytes);
        text = parsed.text;
        if (title === '') title = parsed.title ?? '未命名参考书';
      } catch (cause) {
        throw new HttpError(400, cause instanceof Error ? cause.message : '无法解析 epub 文件');
      }
    }
    if (text.trim() === '') throw new HttpError(400, '上传内容为空');

    const chapters = splitTxtChapters(text).filter((chapter) => chapter.content.length > 0);
    if (chapters.length === 0) throw new HttpError(400, '未能从文件中识别出任何章节');
    return c.json(createReference(db, title, format, chapters), 201);
  });

  app.get('/references', (c) => c.json(listReferences(db)));

  app.get('/references/:id', (c) => {
    const reference = getReference(db, parseId(c.req.param('id')));
    if (!reference) throw new HttpError(404, `参考书 ${c.req.param('id')} 不存在`);
    return c.json(reference);
  });

  app.delete('/references/:id', (c) => {
    const id = parseId(c.req.param('id'));
    if (!deleteReference(db, id)) throw new HttpError(404, `参考书 ${id} 不存在`);
    return c.body(null, 204);
  });

  // ---------- 逐章抽取（断点续跑） ----------

  app.post('/references/:id/extract', async (c) => {
    const referenceId = parseId(c.req.param('id'));
    if (!getReference(db, referenceId)) throw new HttpError(404, `参考书 ${c.req.param('id')} 不存在`);
    const { chapterIds, limit } = parseBody(
      z
        .object({
          chapterIds: z.array(z.number().int().positive()).max(500).optional(),
          limit: z.number().int().min(1).max(20).optional(),
        })
        .strict(),
      await readJson(c)
    );
    try {
      return c.json(await runExtraction(db, llm, referenceId, { chapterIds, limit }));
    } catch (cause) {
      if (cause instanceof RouteNotConfiguredError) throw new HttpError(409, cause.message);
      throw cause;
    }
  });

  // ---------- 确认队列 ----------

  app.get('/references/:id/extractions', (c) => {
    const referenceId = parseId(c.req.param('id'));
    if (!getReference(db, referenceId)) throw new HttpError(404, `参考书 ${c.req.param('id')} 不存在`);
    const raw = c.req.query('status');
    if (raw !== undefined && raw !== '' && !(EXTRACTION_STATUSES as readonly string[]).includes(raw)) {
      throw new HttpError(400, `参数 status：应为 ${EXTRACTION_STATUSES.join('/')}`);
    }
    const status = raw === undefined || raw === '' ? undefined : (raw as ExtractionStatus);
    return c.json(listExtractionItems(db, referenceId, status));
  });

  function requirePendingItem(id: number) {
    const item = getExtractionItem(db, id);
    if (!item) throw new HttpError(404, `抽取条目 ${id} 不存在`);
    if (item.status !== 'pending') throw new HttpError(409, `抽取条目 ${id} 已处理，不可修改`);
    return item;
  }

  app.get('/extractions/:id', (c) => {
    const item = getExtractionItem(db, parseId(c.req.param('id')));
    if (!item) throw new HttpError(404, `抽取条目 ${c.req.param('id')} 不存在`);
    return c.json(item);
  });

  app.patch('/extractions/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    const item = requirePendingItem(id);
    const patch = parseMaterialFieldPatch(item.type, await readJson(c));
    const updated = updateExtractionItem(db, id, patch);
    if (!updated) throw new HttpError(409, `抽取条目 ${id} 已处理，不可修改`);
    return c.json(updated);
  });

  /**
   * 确认入库：默认新建素材并自动带参考书溯源；与全局库同类型同名时必须给出处理方式——
   * new（同名新建）/ merge（追加进已有素材，人工溯源升级为参考书溯源）/ skip（不入库）。
   */
  app.post('/extractions/:id/accept', async (c) => {
    const id = parseId(c.req.param('id'));
    const item = requirePendingItem(id);
    const { resolution, patch } = parseBody(
      z
        .object({
          resolution: z.enum(['new', 'merge', 'skip']).optional(),
          patch: z.unknown().optional(),
        })
        .strict(),
      await readJson(c)
    );

    const fieldPatch = patch === undefined ? {} : parseMaterialFieldPatch(item.type, patch);
    const title = fieldPatch.title ?? item.title;
    const content = fieldPatch.content ?? item.content;
    const payload = { ...item.payload, ...fieldPatch.payload };

    const conflict = findConflictMaterial(db, item.type, title);
    if (conflict && resolution === undefined) {
      throw new HttpError(409, `存在重名素材「${conflict.title}」，请选择处理方式（new/merge/skip）`);
    }

    let materialId: number | null = null;
    if (resolution !== 'skip') {
      const source: MaterialSource = { kind: 'reference', book: getReferenceTitle(db, item.referenceId) ?? '', chapter: item.chapterTitle };
      if (resolution === 'merge') {
        if (!conflict) throw new HttpError(400, '没有可合并的重名素材');
        const existing = getMaterial(db, conflict.materialId)!;
        // 合并语义：正文追加（素材 source 为单值，本条出处随正文行内标注）、payload 只补缺键（既有素材优先）；
        // 人工溯源升级为参考书溯源
        const provenanceNote = `（拆书出处：${source.book} ${source.chapter}）`;
        updateMaterial(db, existing.id, {
          content: `${existing.content}\n\n${content}${provenanceNote}`,
          payload: { ...payload, ...existing.payload },
          ...(existing.source.kind === 'manual' ? { source } : {}),
        });
        materialId = existing.id;
      } else {
        const created = createMaterial(db, { type: item.type, title, content, payload, tags: [], source });
        materialId = created.id;
      }
    }

    archiveExtractionItem(db, id, 'accepted', resolution ?? 'new', materialId);
    return c.json(getExtractionItem(db, id));
  });

  app.post('/extractions/:id/reject', (c) => {
    const id = parseId(c.req.param('id'));
    requirePendingItem(id);
    archiveExtractionItem(db, id, 'rejected');
    return c.json(getExtractionItem(db, id));
  });

  return app;
}
