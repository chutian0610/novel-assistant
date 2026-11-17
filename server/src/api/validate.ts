import type { Context } from 'hono';
import { z } from 'zod';
import { HttpError } from './errors';

/** 读取 JSON 请求体；缺失或非法时统一 400 */
export async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => {
    throw new HttpError(400, '请求体缺失或不是合法 JSON');
  });
}

/** zod safeParse → 统一 400 错误（取第一个 issue，拼上字段路径） */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw toHttpError(result.error.issues);
  }
  return result.data;
}

function toHttpError(issues: z.core.$ZodIssue[]): HttpError {
  const issue = issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.map(String).join('.') : 'body';
  return new HttpError(400, issue ? `参数 ${field}：${issue.message}` : '请求体不合法');
}

/** 路径参数 → 正整数 id */
export function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `非法的 id：${raw}`);
  return id;
}

/** 查询参数分页整数：缺失/空串用默认值，非法值 400 */
export function parsePaginationInt(raw: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `参数 ${name}：应为 ${min}~${max} 的整数`);
  }
  return value;
}
