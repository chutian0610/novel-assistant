import { expect, it } from 'vitest';
import { createTestApp } from './helpers';

it('GET /health 返回 ok', async () => {
  const { request } = createTestApp();
  const res = await request.get('/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });
});

it('未知接口返回 404 与统一错误结构', async () => {
  const { request } = createTestApp();
  const res = await request.get('/api/nowhere');
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: '接口不存在' });
});

it('非法 JSON 请求体返回 400', async () => {
  const { request } = createTestApp();
  const res = await request.post('/api/settings/providers').set('content-type', 'application/json').send('not-json');
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('请求体');
});
