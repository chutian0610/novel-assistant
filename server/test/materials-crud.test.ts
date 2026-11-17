import { expect, it } from 'vitest';
import { createTestApp, seedMaterial } from './helpers';

it('四类素材均可创建并落库（含书骨骼三字段）', async () => {
  const { db, request } = createTestApp();
  for (const type of ['setting', 'trope', 'style', 'skeleton'] as const) {
    const material = await seedMaterial(request, { type });
    expect(material.type).toBe(type);
  }

  const rows = db.prepare('SELECT type, payload, source_kind, source_book FROM materials ORDER BY id').all() as {
    type: string;
    payload: string;
    source_kind: string;
    source_book: string;
  }[];
  expect(rows.map((row) => row.type)).toEqual(['setting', 'trope', 'style', 'skeleton']);

  const skeleton = JSON.parse(rows[3]!.payload) as Record<string, string>;
  expect(Object.keys(skeleton).sort()).toEqual(['archetypes', 'pacingCurve', 'volumeStructure']);
  expect(skeleton.pacingCurve).toContain('黄金三章');

  // seedMaterial 默认：设定卡带参考书溯源，其余人工录入
  expect(rows[0]!.source_kind).toBe('reference');
  expect(rows[0]!.source_book).toBe('参考书甲');
  expect(rows[1]!.source_kind).toBe('manual');
});

it('创建响应携带溯源与标签，正文与结构化字段可回读', async () => {
  const { request } = createTestApp();
  const material = await seedMaterial(request, { type: 'skeleton' });
  expect(material).toMatchObject({
    type: 'skeleton',
    title: '废柴流书骨骼',
    payload: {
      pacingCurve: expect.stringContaining('黄金三章'),
      volumeStructure: expect.stringContaining('第一卷'),
      archetypes: expect.stringContaining('主角'),
    },
    tags: ['测试'],
    source: { kind: 'manual', book: '', chapter: '' },
  });

  const fetched = await request.get(`/api/materials/${material.id}`);
  expect(fetched.status).toBe(200);
  expect(fetched.body).toEqual(material);
});

it('书骨骼缺少任一必备字段返回 400', async () => {
  const { request } = createTestApp();
  const missing = await request.post('/api/materials', {
    type: 'skeleton',
    title: '缺字段',
    content: '正文',
    payload: { pacingCurve: '有', volumeStructure: '有' },
  });
  expect(missing.status).toBe(400);
  expect(missing.body.error).toContain('archetypes');

  const unknownKey = await request.post('/api/materials', {
    type: 'skeleton',
    title: '多字段',
    content: '正文',
    payload: { pacingCurve: 'a', volumeStructure: 'b', archetypes: 'c', extra: 'd' },
  });
  expect(unknownKey.status).toBe(400);
});

it('溯源校验：参考书必须有书名；人工录入不应带书/章', async () => {
  const { request } = createTestApp();
  const noBook = await request.post('/api/materials', {
    type: 'setting',
    title: '缺书名',
    content: '正文',
    source: { kind: 'reference' },
  });
  expect(noBook.status).toBe(400);
  expect(noBook.body.error).toContain('来源书名');

  const manualWithBook = await request.post('/api/materials', {
    type: 'setting',
    title: '人工带书',
    content: '正文',
    source: { kind: 'manual', book: '不该有' },
  });
  expect(manualWithBook.status).toBe(400);
  expect(manualWithBook.body.error).toContain('人工录入');
});

it('基础校验：未知类型/缺标题/缺正文/标签过多返回 400', async () => {
  const { request } = createTestApp();
  expect((await request.post('/api/materials', { type: 'plot' })).status).toBe(400);
  expect((await request.post('/api/materials', { type: 'setting', content: 'x' })).status).toBe(400);
  expect((await request.post('/api/materials', { type: 'setting', title: 'x' })).status).toBe(400);
  expect(
    (await request.post('/api/materials', { type: 'setting', title: 'x', content: 'y', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }))
      .status
  ).toBe(400);
});

it('标签去重与修剪；标签聚合接口返回计数', async () => {
  const { db, request } = createTestApp();
  await seedMaterial(request, { type: 'setting', tags: ['修真', ' 修真 ', '宗门'] });
  await seedMaterial(request, { type: 'trope', tags: ['修真'] });

  const list = (await request.get('/api/materials')).body as { items: { title: string; tags: string[] }[] };
  const settingItem = list.items.find((m) => m.title === '玄天宗')!;
  expect(settingItem.tags).toEqual(['修真', '宗门']); // 按名称升序

  const tags = (await request.get('/api/tags')).body as { name: string; count: number }[];
  expect(tags).toEqual([
    { name: '修真', count: 2 },
    { name: '宗门', count: 1 },
  ]);

  const joinRows = db.prepare('SELECT COUNT(*) AS count FROM material_tags').get() as { count: number };
  expect(joinRows.count).toBe(3);
});

it('PATCH 部分更新：标题/正文/标签/溯源，类型不可变', async () => {
  const env = createTestApp();
  const material = await seedMaterial(env.request, { type: 'setting', tags: ['旧标签'] });

  const typeChange = await env.request.patch(`/api/materials/${material.id}`, { type: 'trope' });
  expect(typeChange.status).toBe(400);

  const patched = await env.request.patch(`/api/materials/${material.id}`, {
    title: '玄天宗（修订）',
    tags: ['新标签'],
    source: { kind: 'manual' },
  });
  expect(patched.status).toBe(200);
  expect(patched.body).toMatchObject({
    title: '玄天宗（修订）',
    tags: ['新标签'],
    source: { kind: 'manual', book: '', chapter: '' },
    type: 'setting',
    content: material.content, // 未提供的字段保持不变
    payload: material.payload,
  });

  // 旧标签无人引用后从聚合中消失
  const tags = (await env.request.get('/api/tags')).body as { name: string }[];
  expect(tags.map((t) => t.name)).toEqual(['新标签']);
});

it('PATCH payload 按既有类型校验；空更新返回 400', async () => {
  const env = createTestApp();
  const material = await seedMaterial(env.request, { type: 'skeleton' });

  const bad = await env.request.patch(`/api/materials/${material.id}`, { payload: { pacingCurve: '' } });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toContain('pacingCurve');

  const good = await env.request.patch(`/api/materials/${material.id}`, {
    payload: { pacingCurve: '三段式节奏', volumeStructure: '四卷结构', archetypes: '双主角' },
  });
  expect(good.status).toBe(200);
  expect(good.body.payload).toEqual({ pacingCurve: '三段式节奏', volumeStructure: '四卷结构', archetypes: '双主角' });

  expect((await env.request.patch(`/api/materials/${material.id}`, {})).status).toBe(400);
});

it('PATCH 不存在的素材返回 404；非法溯源返回 400', async () => {
  const { request } = createTestApp();
  expect((await request.patch('/api/materials/999', { title: 'x' })).status).toBe(404);
  expect((await request.patch('/api/materials/abc', { title: 'x' })).status).toBe(400);

  const env = createTestApp();
  const material = await seedMaterial(env.request, { type: 'setting' });
  const badSource = await env.request.patch(`/api/materials/${material.id}`, {
    source: { kind: 'reference' },
  });
  expect(badSource.status).toBe(400);
  expect(badSource.body.error).toContain('来源书名');
});

it('DELETE 删除素材并级联清理标签关联；不存在的 id 返回 404', async () => {
  const env = createTestApp();
  const material = await seedMaterial(env.request, { type: 'style', tags: ['孤本标签'] });

  expect((await env.request.delete('/api/materials/999')).status).toBe(404);
  expect((await env.request.delete('/api/materials/abc')).status).toBe(400);

  const del = await env.request.delete(`/api/materials/${material.id}`);
  expect(del.status).toBe(204);
  expect((await env.request.get(`/api/materials/${material.id}`)).status).toBe(404);
  expect(((await env.request.get('/api/materials')).body as { total: number }).total).toBe(0);
  expect(((await env.request.get('/api/tags')).body as unknown[]).length).toBe(0);

  const joinRows = env.db.prepare('SELECT COUNT(*) AS count FROM material_tags').get() as { count: number };
  expect(joinRows.count).toBe(0);
});

it('列表支持类型/标签过滤与分页', async () => {
  const env = createTestApp();
  await seedMaterial(env.request, { type: 'setting', title: '甲', tags: ['世界'] });
  await seedMaterial(env.request, { type: 'setting', title: '乙', tags: ['势力'] });
  await seedMaterial(env.request, { type: 'trope', title: '丙' });

  const byType = (await env.request.get('/api/materials?type=setting')).body as { total: number; items: { title: string }[] };
  expect(byType.total).toBe(2);
  expect(byType.items.map((m) => m.title)).toEqual(['乙', '甲']); // updated_at DESC

  const byTag = (await env.request.get('/api/materials?tag=世界')).body as { total: number; items: unknown[] };
  expect(byTag.total).toBe(1);
  expect((byTag.items[0] as { title: string }).title).toBe('甲');

  expect(((await env.request.get('/api/materials?tag=不存在的标签')).body as { total: number }).total).toBe(0);

  const paged = (await env.request.get('/api/materials?limit=2&offset=1')).body as {
    total: number;
    items: { title: string }[];
  };
  expect(paged.total).toBe(3);
  expect(paged.items).toHaveLength(2);

  expect((await env.request.get('/api/materials?type=bogus')).status).toBe(400);
  expect((await env.request.get('/api/materials?limit=x')).status).toBe(400);
});
