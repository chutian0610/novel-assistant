import { expect, it } from 'vitest';
import { createTestApp, seedBook, seedBookMaterial, seedMaterial, type TestBookMaterialItem } from './helpers';

it('四类素材均可引用进书，初始书内视图等于全局原值', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  for (const type of ['setting', 'trope', 'style', 'skeleton'] as const) {
    const material = await seedMaterial(env.request, { type });
    await seedBookMaterial(env.request, book.id, material.id);
  }

  const list = (await env.request.get(`/api/books/${book.id}/materials`)).body as {
    items: TestBookMaterialItem[];
    total: number;
  };
  expect(list.total).toBe(4);
  // 最新引用在前（时间倒序 + id 倒序兜底）
  expect(list.items.map((item) => item.material.type)).toEqual(['skeleton', 'style', 'trope', 'setting']);
  for (const item of list.items) {
    expect(item.overriddenFields).toEqual([]);
    expect(item.effective.title).toBe(item.material.title);
    expect(item.effective.content).toBe(item.material.content);
    expect(item.effective.payload).toEqual(item.material.payload);
    expect(item.material.tags).toEqual(['测试']);
  }
});

it('覆写生效且全局素材原文不变（覆写隔离）', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const material = await seedMaterial(env.request, { type: 'setting' });
  await seedBookMaterial(env.request, book.id, material.id);

  const patched = await env.request.patch(`/api/books/${book.id}/materials/${material.id}`, {
    overrides: { title: '玄天宗（本书版）', payload: { category: '本书专属势力' } },
  });
  expect(patched.status).toBe(200);
  const item = patched.body as TestBookMaterialItem;
  expect(item.effective).toEqual({
    title: '玄天宗（本书版）',
    content: material.content,
    payload: { category: '本书专属势力' },
  });
  expect(item.overriddenFields).toEqual(['payload.category', 'title']); // 点路径字典序

  // 全局库原文不变：API 响应与库内落盘双重断言
  const global = await env.request.get(`/api/materials/${material.id}`);
  expect(global.status).toBe(200);
  expect(global.body).toEqual(material);
  const row = env.db.prepare('SELECT title, payload FROM materials WHERE id = ?').get(material.id) as {
    title: string;
    payload: string;
  };
  expect(row.title).toBe(material.title);
  expect(JSON.parse(row.payload)).toEqual(material.payload);
});

it('未覆写字段跟随全局更新，覆写字段保持遮蔽', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const material = await seedMaterial(env.request, { type: 'style' });
  await seedBookMaterial(env.request, book.id, material.id);

  await env.request.patch(`/api/books/${book.id}/materials/${material.id}`, {
    overrides: { content: '书内改写的文风正文。' },
  });

  // 全局素材后续修订：只应影响未覆写字段
  await env.request.patch(`/api/materials/${material.id}`, { title: '雪原行军（修订）', payload: { rhythm: '长短句交错' } });

  const list = (await env.request.get(`/api/books/${book.id}/materials`)).body as { items: TestBookMaterialItem[] };
  const item = list.items[0]!;
  expect(item.effective.title).toBe('雪原行军（修订）'); // 跟随全局
  expect(item.effective.payload).toEqual({ rhythm: '长短句交错' }); // 跟随全局
  expect(item.effective.content).toBe('书内改写的文风正文。'); // 覆写遮蔽
  expect(item.overriddenFields).toEqual(['content']);
});

it('覆写校验：缺 overrides 键/未知字段/未知 payload 键/空值返回 400', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const setting = await seedMaterial(env.request, { type: 'setting' });
  const skeleton = await seedMaterial(env.request, { type: 'skeleton' });
  await seedBookMaterial(env.request, book.id, setting.id);
  await seedBookMaterial(env.request, book.id, skeleton.id);

  const patch = (materialId: number, body: unknown) =>
    env.request.patch(`/api/books/${book.id}/materials/${materialId}`, body);

  expect((await patch(setting.id, {})).status).toBe(400); // 缺 overrides 键
  expect((await patch(setting.id, { overrides: { tags: ['x'] } })).status).toBe(400); // 未知字段
  expect((await patch(setting.id, { overrides: { payload: { age: '18' } } })).status).toBe(400); // 该类型没有此字段
  expect((await patch(setting.id, { overrides: { title: '   ' } })).status).toBe(400); // 空白覆写值
  expect((await patch(skeleton.id, { overrides: { payload: { pacingCurve: '' } } })).status).toBe(400);

  // skeleton 仅允许三个结构化键，单键覆写合法
  expect((await patch(skeleton.id, { overrides: { payload: { pacingCurve: '缓起陡升' } } })).status).toBe(200);
});

it('overrides 传空对象：清除全部覆写回退全局', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const material = await seedMaterial(env.request, { type: 'trope' });
  await seedBookMaterial(env.request, book.id, material.id);

  const overwritten = await env.request.patch(`/api/books/${book.id}/materials/${material.id}`, {
    overrides: { title: '书内标题', payload: { structure: '书内结构' } },
  });
  expect((overwritten.body as TestBookMaterialItem).effective.title).toBe('书内标题');

  const cleared = await env.request.patch(`/api/books/${book.id}/materials/${material.id}`, { overrides: {} });
  expect(cleared.status).toBe(200);
  const item = cleared.body as TestBookMaterialItem;
  expect(item.effective).toEqual({
    title: material.title,
    content: material.content,
    payload: material.payload,
  });
  expect(item.overriddenFields).toEqual([]);
});

it('引用校验：重复引用 409；书/素材不存在 404；非法 id 400；未引用素材不可覆写或移除', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const otherBook = await seedBook(env.request, { title: '另一本' });
  const material = await seedMaterial(env.request, { type: 'setting' });
  await seedBookMaterial(env.request, book.id, material.id);

  expect((await env.request.post(`/api/books/${book.id}/materials`, { materialId: material.id })).status).toBe(409);
  expect((await env.request.post(`/api/books/${book.id}/materials`, { materialId: 999 })).status).toBe(404);
  expect((await env.request.post('/api/books/999/materials', { materialId: material.id })).status).toBe(404);
  expect((await env.request.post(`/api/books/${book.id}/materials`, { materialId: 'abc' })).status).toBe(400);

  expect(
    (await env.request.patch(`/api/books/${otherBook.id}/materials/${material.id}`, { overrides: {} })).status
  ).toBe(404);
  expect((await env.request.delete(`/api/books/${otherBook.id}/materials/${material.id}`)).status).toBe(404);
});

it('移除引用不删除全局素材，书内覆写从不回写', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const material = await seedMaterial(env.request, { type: 'skeleton' });
  await seedBookMaterial(env.request, book.id, material.id);
  await env.request.patch(`/api/books/${book.id}/materials/${material.id}`, {
    overrides: { payload: { archetypes: '双主角镜像结构' } },
  });

  expect((await env.request.delete(`/api/books/${book.id}/materials/${material.id}`)).status).toBe(204);
  expect(((await env.request.get(`/api/books/${book.id}/materials`)).body as { total: number }).total).toBe(0);

  const global = await env.request.get(`/api/materials/${material.id}`);
  expect(global.status).toBe(200);
  expect((global.body as { payload: Record<string, string> }).payload.archetypes).not.toBe('双主角镜像结构');

  expect((await env.request.delete(`/api/books/${book.id}/materials/${material.id}`)).status).toBe(404);
});

it('删除全局素材后引用级联消失，书与其他引用不受影响', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const removed = await seedMaterial(env.request, { type: 'setting', title: '将删卡' });
  const kept = await seedMaterial(env.request, { type: 'trope', title: '保留桥段' });
  await seedBookMaterial(env.request, book.id, removed.id);
  await seedBookMaterial(env.request, book.id, kept.id);

  expect((await env.request.delete(`/api/materials/${removed.id}`)).status).toBe(204);

  const list = (await env.request.get(`/api/books/${book.id}/materials`)).body as {
    items: TestBookMaterialItem[];
    total: number;
  };
  expect(list.total).toBe(1);
  expect(list.items[0]!.material.title).toBe('保留桥段');
  expect(((await env.request.get('/api/books')).body as { items: { materialCount: number }[] }).items[0]!.materialCount).toBe(1);
});
