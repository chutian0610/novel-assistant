import { expect, it } from 'vitest';
import { createTestApp, seedProvider } from './helpers';

it('路由初始为四个任务、均未指派', async () => {
  const { request } = createTestApp();
  const res = await request.get('/api/settings/routes');
  expect(res.status).toBe(200);
  expect(res.body.map((r: { task: string }) => r.task)).toEqual(['outline', 'draft', 'extract', 'verify']);
  for (const route of res.body as { providerId: unknown; providerName: unknown; effectiveModel: unknown; enabled: unknown }[]) {
    expect(route).toMatchObject({ providerId: null, providerName: null, effectiveModel: null, enabled: true });
  }
});

it('指派供应商后生效模型默认取供应商模型', async () => {
  const env = createTestApp();
  const provider = await seedProvider(env.request, { name: '旗舰', model: 'flagship-x' });

  const res = await env.request.put('/api/settings/routes/outline', { providerId: provider.id });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    task: 'outline',
    providerId: provider.id,
    providerName: '旗舰',
    model: '',
    effectiveModel: 'flagship-x',
  });
});

it('路由模型覆写优先生效并落库', async () => {
  const env = createTestApp();
  const provider = await seedProvider(env.request, { model: 'provider-default' });
  await env.request.put('/api/settings/routes/extract', { providerId: provider.id, model: 'extractor-lite' });

  const res = await env.request.get('/api/settings/routes');
  const extract = (res.body as { task: string; effectiveModel: string | null; model: string }[]).find(
    (r) => r.task === 'extract'
  );
  expect(extract?.model).toBe('extractor-lite');
  expect(extract?.effectiveModel).toBe('extractor-lite');
});

it('取消指派（providerId: null）与停用路由', async () => {
  const env = createTestApp();
  const provider = await seedProvider(env.request);
  await env.request.put('/api/settings/routes/draft', { providerId: provider.id, enabled: false });

  let routes = (await (await env.request.get('/api/settings/routes')).body) as {
    task: string;
    providerId: number | null;
    enabled: boolean;
  }[];
  expect(routes.find((r) => r.task === 'draft')).toMatchObject({ providerId: provider.id, enabled: false });

  await env.request.put('/api/settings/routes/draft', { providerId: null });
  routes = (await (await env.request.get('/api/settings/routes')).body) as typeof routes;
  expect(routes.find((r) => r.task === 'draft')).toMatchObject({ providerId: null, enabled: false });
});

it('未知任务返回 404；未知供应商返回 400', async () => {
  const { request } = createTestApp();
  const badTask = await request.put('/api/settings/routes/plot', { providerId: 1 });
  expect(badTask.status).toBe(404);

  const env = createTestApp();
  const badProvider = await env.request.put('/api/settings/routes/outline', { providerId: 424242 });
  expect(badProvider.status).toBe(400);
  expect(badProvider.body.error).toContain('不存在');
});

it('不同任务可路由到不同供应商（多供应商场景）', async () => {
  const env = createTestApp();
  const flagship = await seedProvider(env.request, { name: '旗舰', model: 'flagship-x' });
  const lite = await seedProvider(env.request, { name: '轻量', model: 'lite-y' });
  await env.request.put('/api/settings/routes/outline', { providerId: flagship.id });
  await env.request.put('/api/settings/routes/verify', { providerId: lite.id });

  const res = await env.request.get('/api/settings/routes');
  const byTask = new Map((res.body as { task: string; providerId: number; effectiveModel: string }[]).map((r) => [r.task, r]));
  expect(byTask.get('outline')).toMatchObject({ providerId: flagship.id, effectiveModel: 'flagship-x' });
  expect(byTask.get('verify')).toMatchObject({ providerId: lite.id, effectiveModel: 'lite-y' });
  expect(byTask.get('draft')?.providerId).toBeNull();
});
