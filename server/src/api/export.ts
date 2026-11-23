import { Hono } from 'hono';
import { z } from 'zod';
import { requireBook } from './books';
import type { DB } from '../db/open';
import { EXPORT_FORMATS, exportBook, ExportEmptyError, VolumeNotFoundError } from '../export/exporter';
import { HttpError } from './errors';
import { parseId } from './validate';

/** 导出路由（T14）：GET /books/:id/export?format=txt|markdown[&volumeId=N] → 纯文本响应 */
export function exportRoutes(deps: { db: DB }) {
  const app = new Hono();

  const formatSchema = z.object({ format: z.enum(EXPORT_FORMATS) });

  app.get('/books/:id/export', (c) => {
    const { db } = deps;
    const bookId = parseId(c.req.param('id'));
    requireBook(db, bookId, c.req.param('id'));

    const rawFormat = c.req.query('format');
    const format = formatSchema.safeParse({ format: rawFormat ?? '' });
    if (!format.success) throw new HttpError(400, '参数 format：必填，取值 txt 或 markdown');

    const rawVolume = c.req.query('volumeId');
    const volumeId = rawVolume === undefined || rawVolume === '' ? undefined : parseId(rawVolume);

    try {
      const result = exportBook(db, bookId, format.data.format, volumeId);
      return c.body(result.body, 200, { 'content-type': result.contentType });
    } catch (cause) {
      if (cause instanceof ExportEmptyError) throw new HttpError(409, cause.message);
      if (cause instanceof VolumeNotFoundError) throw new HttpError(404, cause.message);
      throw cause;
    }
  });

  return app;
}
