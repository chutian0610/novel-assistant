import { expect, it } from 'vitest';
import { createTestApp, seedProvider } from './helpers';

const VALID = {
  name: '主力',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-abc',
  model: 'model-a',
};

it('供应商初始列表为空', async () => {
  const { request } = createTestApp();
  const res = await request.get('/api/settings/providers');
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
});

it('创建供应商并落库（真实 SQLite 断言）', async () => {
  const { db, request } = createTestApp();
  const res = await request.post('/api/settings/providers', { ...VALID, enabled: true });

  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({
    id: expect.any(Number),
    name: '主力',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-abc',
    model: 'model-a',
    enabled: true,
  });

  const row = db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(res.body.id) as Record<string, unknown>;
  expect(row).toMatchObject({ name: '主力', base_url: 'https://api.example.com/v1', api_key: 'sk-abc', enabled: 1 });
  expect(row.created_at).toBeTypeOf('string');
});

it('缺少必填字段或 Base URL 非法时返回 400', async () => {
  const { request } = createTestApp();
  const missing = await request.post('/api/settings/providers', { name: '缺字段' });
  expect(missing.status).toBe(400);

  const badUrl = await request.post('/api/settings/providers', {
    ...VALID,
    name: '坏地址',
    baseUrl: 'ftp://x.example.com',
  });
  expect(badUrl.status).toBe(400);
  expect(badUrl.body.error).toContain('Base URL');
});

it('重名供应商返回 409', async () => {
  const { request } = createTestApp();
  await seedProvider(request, { name: '同名' });
  const res = await request.post('/api/settings/providers', { ...VALID, name: '同名' });
  expect(res.status).toBe(409);
  expect(res.body.error).toContain('同名');
});

it('PATCH 更新部分字段并刷新 updated_at', async () => {
  const env = createTestApp();
  const provider = await seedProvider(env.request);
  const before = provider.updatedAt;

  const res = await env.request.patch(`/api/settings/providers/${provider.id}`, {
    model: 'model-new',
    enabled: false,
  });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    model: 'model-new',
    enabled: false,
    name: '测试供应商',
    baseUrl: provider.baseUrl,
  });

  const row = env.db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(provider.id) as Record<string, unknown>;
  expect(row.enabled).toBe(0);
  expect(String(row.updated_at) >= before).toBe(true);
});

it('PATCH 改名为已有名称返回 409', async () => {
  const env = createTestApp();
  const first = await seedProvider(env.request, { name: '甲' });
  const second = await seedProvider(env.request, { name: '乙' });
  const res = await env.request.patch(`/api/settings/providers/${second.id}`, { name: first.name });
  expect(res.status).toBe(409);
});

it('PATCH / DELETE 不存在的供应商返回 404；非法 id 返回 400', async () => {
  const { request } = createTestApp();
  expect((await request.patch('/api/settings/providers/999', { model: 'x' })).status).toBe(404);
  expect((await request.delete('/api/settings/providers/999')).status).toBe(404);
  expect((await request.patch('/api/settings/providers/abc', { model: 'x' })).status).toBe(400);
});

it('DELETE 删除供应商；引用它的路由被自动置空', async () => {
  const env = createTestApp();
  const provider = await seedProvider(env.request, { name: '被引用' });
  const assigned = await env.request.put('/api/settings/routes/outline', { providerId: provider.id });
  expect(assigned.status).toBe(200);

  const del = await env.request.delete(`/api/settings/providers/${provider.id}`);
  expect(del.status).toBe(204);
  expect(env.db.prepare('SELECT id FROM llm_providers WHERE id = ?').get(provider.id)).toBeUndefined();

  const routes = await env.request.get('/api/settings/routes');
  const outline = (routes.body as { task: string; providerId: number | null }[]).find((r) => r.task === 'outline');
  expect(outline?.providerId).toBeNull();
});
