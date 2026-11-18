import { expect, it } from 'vitest';
import { createTestApp, seedBook, seedBookMaterial, seedMaterial, type TestBook } from './helpers';

it('新建书并回读书契约元数据（题材/基调/承诺）', async () => {
  const { request } = createTestApp();
  const book = await seedBook(request);
  expect(book).toMatchObject({
    title: '北境玄天录',
    genre: '东方玄幻',
    tone: '热血爽文',
    promise: '主角稳步升级，无虐主，伏笔必回收',
    materialCount: 0,
  });
  expect(book.id).toBeGreaterThan(0);

  const fetched = await request.get(`/api/books/${book.id}`);
  expect(fetched.status).toBe(200);
  expect(fetched.body).toEqual(book);
});

it('书契约字段可省略：仅书名即可建书', async () => {
  const { request } = createTestApp();
  const res = await request.post('/api/books', { title: '只填书名' });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ title: '只填书名', genre: '', tone: '', promise: '', materialCount: 0 });
});

it('建书校验：缺书名/空白书名/字段过长/未知字段返回 400', async () => {
  const { request } = createTestApp();
  expect((await request.post('/api/books', {})).status).toBe(400);
  expect((await request.post('/api/books', { title: '   ' })).status).toBe(400);
  expect((await request.post('/api/books', { title: 'x'.repeat(201) })).status).toBe(400);
  expect((await request.post('/api/books', { title: 'x', genre: 'g'.repeat(101) })).status).toBe(400);
  expect((await request.post('/api/books', { title: 'x', promise: 'p'.repeat(2001) })).status).toBe(400);
  expect((await request.post('/api/books', { title: 'x', status: 'draft' })).status).toBe(400);
});

it('PATCH 部分更新书契约；空更新/不存在/非法 id 分别报错', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);

  const patched = await env.request.patch(`/api/books/${book.id}`, { tone: '冷峻写实', promise: '无金手指' });
  expect(patched.status).toBe(200);
  expect(patched.body).toMatchObject({
    title: book.title,
    genre: book.genre,
    tone: '冷峻写实',
    promise: '无金手指',
  });

  expect((await env.request.patch(`/api/books/${book.id}`, {})).status).toBe(400);
  expect((await env.request.patch('/api/books/999', { title: 'x' })).status).toBe(404);
  expect((await env.request.patch('/api/books/abc', { title: 'x' })).status).toBe(400);
});

it('书架列表按更新时间倒序，materialCount 反映书内引用数', async () => {
  const env = createTestApp();
  const first = await seedBook(env.request, { title: '甲书' });
  await seedBook(env.request, { title: '乙书' });

  let list = (await env.request.get('/api/books')).body as { items: TestBook[]; total: number };
  expect(list.total).toBe(2);
  expect(list.items.map((b) => b.title)).toEqual(['乙书', '甲书']);

  const material = await seedMaterial(env.request, { type: 'setting' });
  await seedBookMaterial(env.request, first.id, material.id);
  await env.request.patch(`/api/books/${first.id}`, { tone: '改一下' });

  list = (await env.request.get('/api/books')).body as { items: TestBook[]; total: number };
  expect(list.items[0]!.title).toBe('甲书');
  expect(list.items[0]!.materialCount).toBe(1);
  expect(list.items[1]!.materialCount).toBe(0);
});

it('书架列表支持分页', async () => {
  const env = createTestApp();
  await seedBook(env.request, { title: '甲' });
  await seedBook(env.request, { title: '乙' });
  await seedBook(env.request, { title: '丙' });

  const paged = (await env.request.get('/api/books?limit=2&offset=1')).body as {
    total: number;
    items: { title: string }[];
  };
  expect(paged.total).toBe(3);
  expect(paged.items.map((b) => b.title)).toEqual(['乙', '甲']);

  expect((await env.request.get('/api/books?limit=x')).status).toBe(400);
});

it('书内素材变动刷新书的更新时间', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const material = await seedMaterial(env.request, { type: 'trope' });

  const before = ((await env.request.get(`/api/books/${book.id}`)).body as { updatedAt: string }).updatedAt;
  await seedBookMaterial(env.request, book.id, material.id);
  const afterRef = ((await env.request.get(`/api/books/${book.id}`)).body as { updatedAt: string }).updatedAt;
  expect(afterRef > before).toBe(true);

  await env.request.patch(`/api/books/${book.id}/materials/${material.id}`, { overrides: { title: '书内标题' } });
  const afterOverride = ((await env.request.get(`/api/books/${book.id}`)).body as { updatedAt: string }).updatedAt;
  expect(afterOverride > afterRef).toBe(true);

  await env.request.delete(`/api/books/${book.id}/materials/${material.id}`);
  const afterRemove = ((await env.request.get(`/api/books/${book.id}`)).body as { updatedAt: string }).updatedAt;
  expect(afterRemove > afterOverride).toBe(true);
});

it('删除书只删书内引用，全局素材不受影响', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const kept = await seedMaterial(env.request, { type: 'setting' });
  await seedBookMaterial(env.request, book.id, kept.id);

  expect((await env.request.delete(`/api/books/${book.id}`)).status).toBe(204);
  expect((await env.request.get(`/api/books/${book.id}`)).status).toBe(404);
  expect(((await env.request.get('/api/books')).body as { total: number }).total).toBe(0);

  // 全局素材原样保留
  const material = await env.request.get(`/api/materials/${kept.id}`);
  expect(material.status).toBe(200);
  expect(material.body.title).toBe(kept.title);

  const refs = env.db.prepare('SELECT COUNT(*) AS count FROM book_materials').get() as { count: number };
  expect(refs.count).toBe(0);

  expect((await env.request.delete('/api/books/999')).status).toBe(404);
});
