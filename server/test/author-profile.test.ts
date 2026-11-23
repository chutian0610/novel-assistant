import { expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import { draftResult, PASS_TEXT, semanticResult } from './text-fixtures';
import { configureRoute, createTestApp, seedBook, seedChapterOutline, seedMaterial, seedVolume } from './helpers';
/** 预置一条文风样本素材 */
async function seedStyle(request: ReturnType<typeof createTestApp>['request'], title = '雪原行军') {
  return seedMaterial(request, {
    type: 'style',
    title,
    content: '风雪掠过旷野，他勒住缰绳，呼吸在寒气里凝成白霜。',
  });
}

const PROFILE_PATCH = {
  themePreference: '克制复仇流，拒绝圣母，爽点前置。',
  taboos: '不写肉戏；主角不双标；配角不死而复生。',
};

it('偏好档案默认为空，可维护并对所有书生效', async () => {
  const env = createTestApp();
  const { request } = env;

  const empty = await request.get('/api/settings/author-profile');
  expect(empty.status).toBe(200);
  expect(empty.body).toEqual({ themePreference: '', taboos: '', styleSampleIds: [], styleSamples: [] });

  const style = await seedStyle(request);
  const put = await request.put('/api/settings/author-profile', {
    ...PROFILE_PATCH,
    styleSampleIds: [style.id],
  });
  expect(put.status).toBe(200);
  expect(put.body.themePreference).toBe(PROFILE_PATCH.themePreference);
  expect(put.body.taboos).toBe(PROFILE_PATCH.taboos);
  expect(put.body.styleSamples).toHaveLength(1);
  expect(put.body.styleSamples[0]).toMatchObject({ id: style.id, type: 'style', title: '雪原行军' });

  // 档案是全局单例：第二本书的注入视图同样携带（对所有书生效）
  const bookA = await seedBook(request, { title: '书甲' });
  const bookB = await seedBook(request, { title: '书乙' });
  for (const book of [bookA, bookB]) {
    const volume = await seedVolume(request, book.id);
    const outline = await seedChapterOutline(request, book.id, volume.id);
    await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, { status: 'approved' });
    const view = await request.get(`/api/books/${book.id}/packing?chapter=1`);
    expect(view.status).toBe(200);
    const layer = view.body.layers.find((candidate: { key: string }) => candidate.key === 'authorProfile');
    expect(layer).toMatchObject({ kind: 'must' });
    expect(layer.items.map((item: { title: string }) => item.title)).toEqual([
      '主题偏好',
      '创作禁区',
      '雪原行军',
    ]);
    expect(layer.items[0].text).toContain('克制复仇流');
    expect(layer.items[1].text).toContain('不写肉戏');
    expect(layer.items[2].refType).toBe('style-sample');
  }
});

it('文风样本引用校验：仅接受 style 类型素材，未知素材 400', async () => {
  const env = createTestApp();
  const { request } = env;
  const style = await seedStyle(request);
  const trope = await seedMaterial(request, { type: 'trope' });

  const badType = await request.put('/api/settings/author-profile', { styleSampleIds: [trope.id] });
  expect(badType.status).toBe(400);
  expect(badType.body.error).toContain('style');

  const missing = await request.put('/api/settings/author-profile', { styleSampleIds: [style.id, 99999] });
  expect(missing.status).toBe(400);

  const ok = await request.put('/api/settings/author-profile', { styleSampleIds: [style.id] });
  expect(ok.status).toBe(200);

  // 空补丁拒绝
  expect((await request.put('/api/settings/author-profile', {})).status).toBe(400);
});

it('文风素材删除后档案自动收敛（失效引用不进注入视图）', async () => {
  const env = createTestApp();
  const { request } = env;
  const style = await seedStyle(request);
  await request.put('/api/settings/author-profile', {
    themePreference: '克制',
    styleSampleIds: [style.id],
  });

  await request.delete(`/api/materials/${style.id}`);

  const profile = await request.get('/api/settings/author-profile');
  expect(profile.body.styleSamples).toEqual([]);

  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  const outline = await seedChapterOutline(request, book.id, volume.id);
  await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, { status: 'approved' });
  const view = await request.get(`/api/books/${book.id}/packing?chapter=1`);
  const layer = view.body.layers.find((candidate: { key: string }) => candidate.key === 'authorProfile');
  expect(layer.items.map((item: { title: string }) => item.title)).toEqual(['主题偏好']);
});

it('档案进入预算装填必带层：预算再小也不截断', async () => {
  const env = createTestApp();
  const { request } = env;
  const style = await seedStyle(request);
  await request.put('/api/settings/author-profile', { ...PROFILE_PATCH, styleSampleIds: [style.id] });

  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  const outline = await seedChapterOutline(request, book.id, volume.id);
  await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, { status: 'approved' });

  // 预算压到 1：必带层永不丢失（overBudget 标记超额），authorProfile 层完整
  const view = await request.get(`/api/books/${book.id}/packing?chapter=1&budget=1`);
  expect(view.body.overBudget).toBe(true);
  const layer = view.body.layers.find((candidate: { key: string }) => candidate.key === 'authorProfile');
  expect(layer.kind).toBe('must');
  expect(layer.items).toHaveLength(3);

  // 层序固定：契约 → 作者偏好 → 大纲 → 角色运行时 → 相关素材
  expect(view.body.layers.map((candidate: { key: string }) => candidate.key)).toEqual([
    'contract',
    'authorProfile',
    'outline',
    'characters',
    'relevance',
  ]);
});

it('档案作为常驻内容进入 draft prompt', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
  const env = createTestApp(llm);
  const { request } = env;
  const style = await seedStyle(request);
  await request.put('/api/settings/author-profile', { ...PROFILE_PATCH, styleSampleIds: [style.id] });

  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  const outline = await seedChapterOutline(request, book.id, volume.id);
  await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, { status: 'approved' });
  for (const task of ['draft', 'verify'] as const) {
    await configureRoute(request, task);
  }

  const res = await request.post(`/api/books/${book.id}/chapters/1/generate`, {});
  expect(res.status).toBe(200);
  const userMessage = llm.calls.find((call) => call.task === 'draft')!.req.messages[1]!.content;
  expect(userMessage).toContain('克制复仇流');
  expect(userMessage).toContain('不写肉戏');
  expect(userMessage).toContain('风雪掠过旷野');
});
