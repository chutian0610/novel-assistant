import { Hono } from 'hono';
import { z } from 'zod';
import type { DB } from '../db/open';
import { resolveRoute } from '../llm/resolver';
import { PROBE_REQUEST, TASK_TYPES, type LLMProvider, type TaskType } from '../llm/types';
import { getPipelineConfig, INTERVENTION_MODES, MAX_AUTO_RUN_LIMIT, updatePipelineConfig } from '../pipeline/config';
import { HttpError } from './errors';
import { parseBody, parseId, readJson } from './validate';

interface ProviderRow {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface RouteRow {
  task: string;
  provider_id: number | null;
  model: string;
  enabled: number;
  updated_at: string;
  provider_name: string | null;
  provider_model: string | null;
}

/** 路由 + 供应商联查（GET 列表与单行共用），列表顺序在 JS 侧按 TASK_TYPES 排 */
const ROUTE_WITH_PROVIDER_SELECT = `
  SELECT r.task, r.provider_id, r.model, r.enabled, r.updated_at,
         p.name AS provider_name, p.model AS provider_model
  FROM llm_task_routes r
  LEFT JOIN llm_providers p ON p.id = r.provider_id`;

const providerCreateSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(100, '名称过长'),
  baseUrl: z.string().trim().refine(isHttpUrl, 'Base URL 必须是 http(s) 地址'),
  apiKey: z.string().max(500, 'API Key 过长').default(''),
  model: z.string().trim().min(1, '模型不能为空').max(200, '模型名过长'),
  enabled: z.boolean().default(true),
});

const providerPatchSchema = z
  .object({
    name: z.string().trim().min(1, '名称不能为空').max(100, '名称过长').optional(),
    baseUrl: z.string().trim().refine(isHttpUrl, 'Base URL 必须是 http(s) 地址').optional(),
    apiKey: z.string().max(500, 'API Key 过长').optional(),
    model: z.string().trim().min(1, '模型不能为空').max(200, '模型名过长').optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, '至少提供一个要更新的字段');

const routePutSchema = z
  .object({
    providerId: z.number().int().nullable().optional(),
    model: z.string().max(200, '模型名过长').optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, '至少提供一个要更新的字段');

/** 设置模块：供应商管理 + 任务路由表 + 路由连通性测试 */
export function settingsRoutes(deps: { db: DB; llm: LLMProvider }) {
  const { db, llm } = deps;
  const app = new Hono();

  // ---------- 供应商管理 ----------

  app.get('/providers', (c) => {
    const rows = db.prepare('SELECT * FROM llm_providers ORDER BY id').all() as ProviderRow[];
    return c.json(rows.map(toProviderJson));
  });

  app.post('/providers', async (c) => {
    const body = parseBody(providerCreateSchema, await readJson(c));
    assertNameFree(db, body.name);
    const info = db
      .prepare('INSERT INTO llm_providers (name, base_url, api_key, model, enabled) VALUES (?, ?, ?, ?, ?)')
      .run(body.name, body.baseUrl, body.apiKey, body.model, body.enabled ? 1 : 0);
    return c.json(toProviderJson(getProviderRow(db, Number(info.lastInsertRowid))), 201);
  });

  app.patch('/providers/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    const body = parseBody(providerPatchSchema, await readJson(c));
    const existing = getProviderRow(db, id);
    if (body.name !== undefined) assertNameFree(db, body.name, id);

    db.prepare(
      `UPDATE llm_providers
       SET name = ?, base_url = ?, api_key = ?, model = ?, enabled = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`
    ).run(
      body.name ?? existing.name,
      body.baseUrl ?? existing.base_url,
      body.apiKey ?? existing.api_key,
      body.model ?? existing.model,
      (body.enabled ?? existing.enabled === 1) ? 1 : 0,
      id
    );
    return c.json(toProviderJson(getProviderRow(db, id)));
  });

  app.delete('/providers/:id', (c) => {
    const id = parseId(c.req.param('id'));
    getProviderRow(db, id);
    db.prepare('DELETE FROM llm_providers WHERE id = ?').run(id);
    // 引用该供应商的任务路由由外键 ON DELETE SET NULL 自动取消指派
    return c.body(null, 204);
  });

  // ---------- 任务路由表 ----------

  app.get('/routes', (c) => {
    const rows = db.prepare(ROUTE_WITH_PROVIDER_SELECT).all() as RouteRow[];
    const order = TASK_TYPES as readonly string[];
    rows.sort((a, b) => order.indexOf(a.task) - order.indexOf(b.task));
    return c.json(rows.map(toRouteJson));
  });

  app.put('/routes/:task', async (c) => {
    const task = parseTask(c.req.param('task'));
    const body = parseBody(routePutSchema, await readJson(c));
    const current = getRouteRowPlain(db, task);

    if (body.providerId !== undefined && body.providerId !== null) {
      const exists = db.prepare('SELECT id FROM llm_providers WHERE id = ?').get(body.providerId);
      if (!exists) throw new HttpError(400, `供应商 ${body.providerId} 不存在`);
    }

    db.prepare(
      `UPDATE llm_task_routes
       SET provider_id = ?, model = ?, enabled = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE task = ?`
    ).run(
      body.providerId !== undefined ? body.providerId : current.provider_id,
      body.model !== undefined ? body.model : current.model,
      (body.enabled !== undefined ? body.enabled : current.enabled === 1) ? 1 : 0,
      task
    );
    return c.json(toRouteJson(getRouteRowWithProvider(db, task)));
  });

  // ---------- 路由连通性测试 ----------

  app.post('/routes/:task/test', async (c) => {
    const task = parseTask(c.req.param('task'));
    const route = resolveRoute(db, task);
    if (!route) throw new HttpError(409, `任务「${task}」尚未配置可用的路由（缺供应商或已停用）`);

    const startedAt = Date.now();
    let ok = true;
    let error: string | undefined;
    try {
      await llm.complete(task, PROBE_REQUEST);
    } catch (cause) {
      ok = false;
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return c.json({
      ok,
      latencyMs: Date.now() - startedAt,
      provider: { id: route.providerId, name: route.providerName },
      model: route.model,
      baseUrl: route.baseUrl,
      error,
    });
  });

  // ---------- 管线预设（T13，ADR-0001 两预设） ----------

  const pipelineConfigSchema = z
    .object({
      mode: z.enum(INTERVENTION_MODES).optional(),
      autoRunLimit: z.number().int().min(1, '连跑上限至少为 1').max(MAX_AUTO_RUN_LIMIT, `连跑上限最大 ${MAX_AUTO_RUN_LIMIT}`).optional(),
    })
    .strict()
    .refine((patch) => Object.keys(patch).length > 0, '至少提供一个要更新的字段');

  app.get('/pipeline', (c) => {
    return c.json(getPipelineConfig(deps.db));
  });

  app.put('/pipeline', async (c) => {
    const patch = parseBody(pipelineConfigSchema, await readJson(c));
    return c.json(updatePipelineConfig(deps.db, patch));
  });

  return app;
}

// ---------- 工具函数 ----------

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseTask(raw: string): TaskType {
  if (!(TASK_TYPES as readonly string[]).includes(raw)) {
    throw new HttpError(404, `未知的任务类型：${raw}`);
  }
  return raw as TaskType;
}

function assertNameFree(db: DB, name: string, excludeId?: number): void {
  const row =
    excludeId === undefined
      ? db.prepare('SELECT id FROM llm_providers WHERE name = ?').get(name)
      : db.prepare('SELECT id FROM llm_providers WHERE name = ? AND id != ?').get(name, excludeId);
  if (row) throw new HttpError(409, `供应商名称「${name}」已存在`);
}

function getProviderRow(db: DB, id: number): ProviderRow {
  const row = db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(id) as ProviderRow | undefined;
  if (!row) throw new HttpError(404, `供应商 ${id} 不存在`);
  return row;
}

function getRouteRowPlain(db: DB, task: TaskType) {
  const row = db.prepare('SELECT * FROM llm_task_routes WHERE task = ?').get(task) as
    | { task: string; provider_id: number | null; model: string; enabled: number; updated_at: string }
    | undefined;
  if (!row) throw new HttpError(404, `任务路由 ${task} 不存在`);
  return row;
}

function getRouteRowWithProvider(db: DB, task: TaskType): RouteRow {
  const row = db.prepare(`${ROUTE_WITH_PROVIDER_SELECT} WHERE r.task = ?`).get(task) as RouteRow | undefined;
  if (!row) throw new HttpError(404, `任务路由 ${task} 不存在`);
  return row;
}

function toProviderJson(row: ProviderRow) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: row.model,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRouteJson(row: RouteRow) {
  return {
    task: row.task,
    providerId: row.provider_id,
    providerName: row.provider_name,
    model: row.model,
    enabled: row.enabled === 1,
    effectiveModel: row.provider_id === null ? null : row.model || row.provider_model,
    updatedAt: row.updated_at,
  };
}
