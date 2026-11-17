import { expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import { PROBE_REQUEST } from '../src/llm/types';
import { createTestApp, seedProvider } from './helpers';

it('未配置路由时返回 409', async () => {
  const { request } = createTestApp();
  const res = await request.post('/api/settings/routes/outline/test');
  expect(res.status).toBe(409);
  expect(res.body.error).toContain('outline');
});

it('已配置路由走注入的 FakeLLM，报告成功与解析出的生效配置', async () => {
  const llm = new FakeLLM();
  const env = createTestApp(llm);
  const provider = await seedProvider(env.request, {
    name: '旗舰',
    baseUrl: 'https://api-a.example.com/v1',
    model: 'flagship-x',
  });
  await env.request.put('/api/settings/routes/outline', { providerId: provider.id, model: 'outline-override' });

  const res = await env.request.post('/api/settings/routes/outline/test');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    ok: true,
    provider: { id: provider.id, name: '旗舰' },
    model: 'outline-override',
    baseUrl: 'https://api-a.example.com/v1',
  });
  expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
  expect(res.body.error).toBeUndefined();

  // FakeLLM 收到的正是该任务的最小探测请求
  expect(llm.calls).toHaveLength(1);
  expect(llm.calls[0]!.task).toBe('outline');
  expect(llm.calls[0]!.req).toEqual(PROBE_REQUEST);
});

it('无模型覆写时按供应商默认模型路由', async () => {
  const llm = new FakeLLM();
  const env = createTestApp(llm);
  const provider = await seedProvider(env.request, { name: '轻量', model: 'lite-y' });
  await env.request.put('/api/settings/routes/extract', { providerId: provider.id });

  const res = await env.request.post('/api/settings/routes/extract/test');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ ok: true, model: 'lite-y' });
  expect(llm.calls[0]!.task).toBe('extract');
});

it('FakeLLM 抛错时返回 ok:false 与错误信息', async () => {
  const llm = new FakeLLM({ respond: { draft: new Error('连接超时') } });
  const env = createTestApp(llm);
  const provider = await seedProvider(env.request);
  await env.request.put('/api/settings/routes/draft', { providerId: provider.id });

  const res = await env.request.post('/api/settings/routes/draft/test');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ ok: false, error: '连接超时' });
  expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
});

it('停用的路由或停用的供应商不可测试（409）', async () => {
  const env = createTestApp();
  const provider = await seedProvider(env.request, { name: '停用供应商', enabled: false });
  await env.request.put('/api/settings/routes/verify', { providerId: provider.id });

  const disabledProvider = await env.request.post('/api/settings/routes/verify/test');
  expect(disabledProvider.status).toBe(409);

  const active = await seedProvider(env.request, { name: '正常供应商' });
  await env.request.put('/api/settings/routes/verify', { providerId: active.id, enabled: false });
  const disabledRoute = await env.request.post('/api/settings/routes/verify/test');
  expect(disabledRoute.status).toBe(409);
});

it('未知任务类型返回 404', async () => {
  const { request } = createTestApp();
  const res = await request.post('/api/settings/routes/nope/test');
  expect(res.status).toBe(404);
});
