import { z } from 'zod';
import type { MaterialFieldPatch, MaterialType } from '../materials/store';
import { HttpError } from './errors';
import { materialFieldSchemas, payloadFieldSchemas } from './materials';
import { parseBody } from './validate';

/**
 * 素材字段的按键补丁校验（书内覆写与抽取条目修改共用同一语义）：
 * title/content 复用全局规则；payload 按素材类型的合法键逐键部分校验
 * （不要求该类型全部字段齐备，合并结果天然合法）。
 * fieldLabel 用于错误消息中的字段名（覆写接口为 overrides，抽取修改为 patch）。
 */
export function parseMaterialFieldPatch(type: MaterialType, body: unknown, fieldLabel = 'patch'): MaterialFieldPatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, `参数 ${fieldLabel}：应为对象`);
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
  const patch: MaterialFieldPatch = {};
  if (data.title !== undefined) patch.title = data.title;
  if (data.content !== undefined) patch.content = data.content;
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
    patch.payload = payload;
  }
  return patch;
}
