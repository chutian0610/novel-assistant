import type { ErrorHandler, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from './errors';

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const startedAt = Date.now();
  await next();
  console.log(`${c.req.method} ${c.req.path} -> ${c.res.status} ${Date.now() - startedAt}ms`);
};

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as ContentfulStatusCode);
  }
  console.error(`未处理错误：${c.req.method} ${c.req.path}`, err);
  return c.json({ error: '服务器内部错误' }, 500);
};
