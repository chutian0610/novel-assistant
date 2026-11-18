import { expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import { configureRoute, createTestApp, getOutlineTree, outlineResult, seedBook, seedChapterOutline, seedVolume } from './helpers';

// ---------- 卷纲 CRUD ----------

it('新增卷纲并回读：挂在书下，树查询返回空章纲列表', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);

  const volume = await seedVolume(env.request, book.id);
  expect(volume).toMatchObject({
    bookId: book.id,
    title: '第一卷·宗门试炼',
    summary: '主角入门，黄金三章小高潮，卷末大比夺魁。',
  });
  expect(volume.id).toBeGreaterThan(0);

  const tree = await getOutlineTree(env.request, book.id);
  expect(tree.volumes).toHaveLength(1);
  expect(tree.volumes[0]).toMatchObject({ id: volume.id, title: volume.title });
  expect(tree.volumes[0]!.chapters).toEqual([]);

  // 未挂大纲的书返回空卷列表而非 404
  const empty = await seedBook(env.request, { title: '无大纲的书' });
  expect((await getOutlineTree(env.request, empty.id)).volumes).toEqual([]);
});

it('卷纲归属书：跨书路径不可见（404），书本身不存在也 404', async () => {
  const env = createTestApp();
  const bookA = await seedBook(env.request, { title: '甲书' });
  const bookB = await seedBook(env.request, { title: '乙书' });
  const volume = await seedVolume(env.request, bookA.id);

  expect((await env.request.get(`/api/books/${bookB.id}/outlines`)).body.volumes).toEqual([]);
  expect((await env.request.patch(`/api/books/${bookB.id}/outlines/volumes/${volume.id}`, { title: '劫走' })).status).toBe(404);
  expect((await env.request.get(`/api/books/999/outlines`)).status).toBe(404);
  expect((await env.request.post(`/api/books/999/outlines/volumes`, { title: 'x' })).status).toBe(404);
});

it('卷纲校验：缺标题/空白标题/过长/未知字段返回 400', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const base = `/api/books/${book.id}/outlines/volumes`;

  expect((await env.request.post(base, {})).status).toBe(400);
  expect((await env.request.post(base, { title: '   ' })).status).toBe(400);
  expect((await env.request.post(base, { title: 'x'.repeat(201) })).status).toBe(400);
  expect((await env.request.post(base, { title: 'x', summary: 's'.repeat(20_001) })).status).toBe(400);
  expect((await env.request.post(base, { title: 'x', status: 'approved' })).status).toBe(400);
});

it('PATCH 卷纲部分更新；空更新/不存在分别报错', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);

  const patched = await env.request.patch(`/api/books/${book.id}/outlines/volumes/${volume.id}`, {
    summary: '改线：加入双线叙事。',
  });
  expect(patched.status).toBe(200);
  expect(patched.body).toMatchObject({ title: volume.title, summary: '改线：加入双线叙事。' });

  expect((await env.request.patch(`/api/books/${book.id}/outlines/volumes/${volume.id}`, {})).status).toBe(400);
  expect((await env.request.patch(`/api/books/${book.id}/outlines/volumes/999`, { title: 'x' })).status).toBe(404);
});

it('删除卷纲级联删除其下章纲', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  await seedChapterOutline(env.request, book.id, volume.id);

  expect((await env.request.delete(`/api/books/${book.id}/outlines/volumes/${volume.id}`)).status).toBe(204);
  expect((await getOutlineTree(env.request, book.id)).volumes).toEqual([]);
  const rows = env.db.prepare('SELECT COUNT(*) AS count FROM chapter_outlines').get() as { count: number };
  expect(rows.count).toBe(0);

  expect((await env.request.delete(`/api/books/${book.id}/outlines/volumes/${volume.id}`)).status).toBe(404);
});

// ---------- 章纲 CRUD ----------

it('新增章纲默认草稿态，挂在指定卷下；卷不存在/跨书 404', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const otherBook = await seedBook(env.request, { title: '别的书' });
  const volume = await seedVolume(env.request, book.id);
  const otherVolume = await seedVolume(env.request, otherBook.id);

  const chapter = await seedChapterOutline(env.request, book.id, volume.id);
  expect(chapter).toMatchObject({
    volumeId: volume.id,
    title: '第1章 废柴觉醒',
    summary: '测灵仪前受辱，当夜觉醒神秘功法。',
    status: 'draft',
  });

  // 章纲只挂在自己书的卷下：跨书引用别家的卷一律不可见
  expect((await env.request.post(`/api/books/${book.id}/outlines/volumes/${otherVolume.id}/chapters`, { title: 'x' })).status).toBe(404);
  expect((await env.request.post(`/api/books/${book.id}/outlines/volumes/999/chapters`, { title: 'x' })).status).toBe(404);
});

it('章纲树按卷分组、按创建顺序排列', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const volumeOne = await seedVolume(env.request, book.id, { title: '卷一' });
  const volumeTwo = await seedVolume(env.request, book.id, { title: '卷二' });
  const c12 = await seedChapterOutline(env.request, book.id, volumeOne.id, { title: '第2章' });
  const c11 = await seedChapterOutline(env.request, book.id, volumeOne.id, { title: '第1章' });
  const c21 = await seedChapterOutline(env.request, book.id, volumeTwo.id, { title: '第3章' });

  const tree = await getOutlineTree(env.request, book.id);
  expect(tree.volumes.map((v) => v.title)).toEqual(['卷一', '卷二']);
  expect(tree.volumes[0]!.chapters.map((chapter) => chapter.title)).toEqual([c12.title, c11.title]);
  expect(tree.volumes[1]!.chapters.map((chapter) => chapter.title)).toEqual([c21.title]);
});

it('PATCH/DELETE 章纲；校验与 404 语义同卷纲', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  const chapter = await seedChapterOutline(env.request, book.id, volume.id);

  const patched = await env.request.patch(`/api/books/${book.id}/outlines/chapters/${chapter.id}`, {
    title: '第1章 测灵大典',
    summary: '改线：反派提前登场。',
  });
  expect(patched.status).toBe(200);
  expect(patched.body).toMatchObject({ title: '第1章 测灵大典', summary: '改线：反派提前登场。', status: 'draft' });

  expect((await env.request.patch(`/api/books/${book.id}/outlines/chapters/${chapter.id}`, {})).status).toBe(400);
  expect((await env.request.patch(`/api/books/${book.id}/outlines/chapters/999`, { title: 'x' })).status).toBe(404);
  expect((await env.request.patch(`/api/books/${book.id}/outlines/chapters/${chapter.id}`, { title: 'x'.repeat(201) })).status).toBe(400);

  expect((await env.request.delete(`/api/books/${book.id}/outlines/chapters/${chapter.id}`)).status).toBe(204);
  expect((await env.request.delete(`/api/books/${book.id}/outlines/chapters/${chapter.id}`)).status).toBe(404);
});

// ---------- 状态机 ----------

it('合法流转：草稿→已批准→锁定，逐步回读', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  const chapter = await seedChapterOutline(env.request, book.id, volume.id);
  const url = `/api/books/${book.id}/outlines/chapters/${chapter.id}/status`;

  const approved = await env.request.post(url, { status: 'approved' });
  expect(approved.status).toBe(200);
  expect(approved.body.status).toBe('approved');

  const locked = await env.request.post(url, { status: 'locked' });
  expect(locked.status).toBe(200);
  expect(locked.body.status).toBe('locked');

  const reread = (await env.request.get(`/api/books/${book.id}/outlines`)).body;
  expect(reread.volumes[0].chapters[0].status).toBe('locked');
});

it('显式解锁：锁定→已批准，之后可再编辑与再锁定', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  const chapter = await seedChapterOutline(env.request, book.id, volume.id);
  const statusUrl = `/api/books/${book.id}/outlines/chapters/${chapter.id}/status`;
  await env.request.post(statusUrl, { status: 'approved' });
  await env.request.post(statusUrl, { status: 'locked' });

  const unlocked = await env.request.post(statusUrl, { status: 'approved' });
  expect(unlocked.status).toBe(200);
  expect(unlocked.body.status).toBe('approved');

  const edited = await env.request.patch(`/api/books/${book.id}/outlines/chapters/${chapter.id}`, { summary: '解锁后改写。' });
  expect(edited.status).toBe(200);
  expect((await env.request.post(statusUrl, { status: 'locked' })).status).toBe(200);
});

it('非法流转一律拒绝：跳级锁定/回退草稿/同态迁移（409），未知目标值（400）', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  const chapter = await seedChapterOutline(env.request, book.id, volume.id);
  const statusUrl = `/api/books/${book.id}/outlines/chapters/${chapter.id}/status`;

  expect((await env.request.post(statusUrl, { status: 'locked' })).status).toBe(409);
  expect((await env.request.post(statusUrl, { status: 'draft' })).status).toBe(409);

  await env.request.post(statusUrl, { status: 'approved' });
  expect((await env.request.post(statusUrl, { status: 'draft' })).status).toBe(409);

  await env.request.post(statusUrl, { status: 'locked' });
  expect((await env.request.post(statusUrl, { status: 'draft' })).status).toBe(409);
  expect((await env.request.post(statusUrl, { status: 'locked' })).status).toBe(409);

  expect((await env.request.post(statusUrl, { status: 'published' })).status).toBe(400);
  expect((await env.request.post(statusUrl, {})).status).toBe(400);
});

// ---------- 锁定语义 ----------

it('锁定后不可编辑不可删除（409），解锁恢复', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  const chapter = await seedChapterOutline(env.request, book.id, volume.id);
  const statusUrl = `/api/books/${book.id}/outlines/chapters/${chapter.id}/status`;
  await env.request.post(statusUrl, { status: 'approved' });
  await env.request.post(statusUrl, { status: 'locked' });

  const patchRes = await env.request.patch(`/api/books/${book.id}/outlines/chapters/${chapter.id}`, { summary: '偷偷改' });
  expect(patchRes.status).toBe(409);
  expect(patchRes.body.error).toContain('锁定');

  expect((await env.request.delete(`/api/books/${book.id}/outlines/chapters/${chapter.id}`)).status).toBe(409);

  await env.request.post(statusUrl, { status: 'approved' });
  expect((await env.request.patch(`/api/books/${book.id}/outlines/chapters/${chapter.id}`, { summary: '解锁后改。' })).status).toBe(200);
  expect((await env.request.delete(`/api/books/${book.id}/outlines/chapters/${chapter.id}`)).status).toBe(204);
});

it('含锁定章纲的卷不可整体删除（409），解锁后可删', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  const lockedChapter = await seedChapterOutline(env.request, book.id, volume.id, { title: '锁定章' });
  await seedChapterOutline(env.request, book.id, volume.id, { title: '草稿章' });
  const statusUrl = `/api/books/${book.id}/outlines/chapters/${lockedChapter.id}/status`;
  await env.request.post(statusUrl, { status: 'approved' });
  await env.request.post(statusUrl, { status: 'locked' });

  const res = await env.request.delete(`/api/books/${book.id}/outlines/volumes/${volume.id}`);
  expect(res.status).toBe(409);
  expect(res.body.error).toContain('锁定');
  expect((await getOutlineTree(env.request, book.id)).volumes).toHaveLength(1);

  await env.request.post(statusUrl, { status: 'approved' });
  expect((await env.request.delete(`/api/books/${book.id}/outlines/volumes/${volume.id}`)).status).toBe(204);
});

// ---------- AI 多方案展开 ----------

it('展开走 outline 任务路由，一次给出 3 个方案；prompt 携带书契约/卷纲/章纲/作者要求', async () => {
  const llm = new FakeLLM({
    respond: {
      outline: outlineResult([
        { title: '第1章 测灵大典', summary: '主角测出废灵根受尽嘲讽，当夜神秘功法自行运转。' },
        { title: '第1章 雪夜来客', summary: '神秘老者雪夜叩门，留下一枚残玉改变主角命格。' },
        { title: '第1章 宗门大比', summary: '以大比开场，主角绝境反杀一举惊四座。' },
      ]),
    },
  });
  const env = createTestApp(llm);
  await configureRoute(env.request, 'outline');
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  const chapter = await seedChapterOutline(env.request, book.id, volume.id);

  const res = await env.request.post(`/api/books/${book.id}/outlines/chapters/${chapter.id}/expansions`, {
    hint: '前紧后松，章末留钩子',
  });
  expect(res.status).toBe(200);
  expect(res.body.model).toBe('fake-outline');
  expect(res.body.options).toHaveLength(3);
  expect(res.body.options[0]).toEqual({ index: 1, title: '第1章 测灵大典', summary: '主角测出废灵根受尽嘲讽，当夜神秘功法自行运转。' });
  expect(res.body.options.map((o: { index: number }) => o.index)).toEqual([1, 2, 3]);

  expect(llm.calls).toHaveLength(1);
  expect(llm.calls[0]!.task).toBe('outline');
  const prompt = llm.calls[0]!.req.messages.map((m) => m.content).join('\n');
  expect(prompt).toContain('东方玄幻');
  expect(prompt).toContain('热血爽文');
  expect(prompt).toContain('伏笔必回收');
  expect(prompt).toContain('第一卷·宗门试炼');
  expect(prompt).toContain('卷末大比夺魁');
  expect(prompt).toContain('第1章 废柴觉醒');
  expect(prompt).toContain('测灵仪前受辱');
  expect(prompt).toContain('前紧后松，章末留钩子');
});

it('展开数量契约：LLM 给 5 个取 5 个，给 6 个截到 5 个，少于 3 个视为产出不合法（502）', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'outline');
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  const chapter = await seedChapterOutline(env.request, book.id, volume.id);
  const url = `/api/books/${book.id}/outlines/chapters/${chapter.id}/expansions`;

  const option = { title: '方案', summary: '概要' };
  env.llm.script.respond = { outline: outlineResult([option, option, option, option, option]) };
  expect((await env.request.post(url, {})).body.options).toHaveLength(5);

  env.llm.script.respond = { outline: outlineResult([option, option, option, option, option, option]) };
  expect((await env.request.post(url, {})).body.options).toHaveLength(5);

  env.llm.script.respond = { outline: outlineResult([option, option]) };
  const tooFew = await env.request.post(url, {});
  expect(tooFew.status).toBe(502);
  expect(tooFew.body.error).toContain('3');

  env.llm.script.respond = { outline: { content: '这不是 JSON', model: 'fake' } };
  expect((await env.request.post(url, {})).status).toBe(502);
});

it('路由未配置时展开返回 409；hint 可省略时正常产出', async () => {
  const env = createTestApp();
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  const chapter = await seedChapterOutline(env.request, book.id, volume.id);
  const url = `/api/books/${book.id}/outlines/chapters/${chapter.id}/expansions`;

  // outline 路由未配置：先打一发确认 409，再配置后重试
  expect((await env.request.post(url, {})).status).toBe(409);

  await configureRoute(env.request, 'outline');
  env.llm.script.respond = {
    outline: outlineResult([
      { title: '甲', summary: '甲案' },
      { title: '乙', summary: '乙案' },
      { title: '丙', summary: '丙案' },
    ]),
  };
  const withRoute = await env.request.post(url, {});
  expect(withRoute.status).toBe(200);
  expect(withRoute.body.options).toHaveLength(3);

  expect((await env.request.post(`/api/books/999/outlines/chapters/${chapter.id}/expansions`, {})).status).toBe(404);
  expect((await env.request.post(`/api/books/${book.id}/outlines/chapters/999/expansions`, {})).status).toBe(404);
});

it('全链路：展开→作者选定写入章纲（FakeLLM 驱动）；锁定章只读不可写入', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'outline');
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  const chapter = await seedChapterOutline(env.request, book.id, volume.id);

  const chosen = { title: '第1章 雪夜来客', summary: '神秘老者雪夜叩门，留下一枚残玉改变主角命格。' };
  env.llm.script.respond = { outline: outlineResult([{ title: 'a', summary: 'b' }, { title: 'c', summary: 'd' }, chosen]) };

  const expansions = await env.request.post(`/api/books/${book.id}/outlines/chapters/${chapter.id}/expansions`, {});
  const picked = expansions.body.options[2];

  const applied = await env.request.patch(`/api/books/${book.id}/outlines/chapters/${chapter.id}`, {
    title: picked.title,
    summary: picked.summary,
  });
  expect(applied.status).toBe(200);
  expect(applied.body).toMatchObject({ title: chosen.title, summary: chosen.summary, status: 'draft' });

  // 锁定后：方案仍可请求（只读），但选定写入被拒
  const statusUrl = `/api/books/${book.id}/outlines/chapters/${chapter.id}/status`;
  await env.request.post(statusUrl, { status: 'approved' });
  await env.request.post(statusUrl, { status: 'locked' });
  expect((await env.request.post(`/api/books/${book.id}/outlines/chapters/${chapter.id}/expansions`, {})).status).toBe(200);
  expect(
    (await env.request.patch(`/api/books/${book.id}/outlines/chapters/${chapter.id}`, { title: picked.title })).status
  ).toBe(409);
});

it('展开请求体校验：hint 过长/非字符串返回 400', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'outline');
  const book = await seedBook(env.request);
  const volume = await seedVolume(env.request, book.id);
  const chapter = await seedChapterOutline(env.request, book.id, volume.id);
  const url = `/api/books/${book.id}/outlines/chapters/${chapter.id}/expansions`;

  expect((await env.request.post(url, { hint: 'x'.repeat(2001) })).status).toBe(400);
  expect((await env.request.post(url, { hint: 42 })).status).toBe(400);
  expect((await env.request.post(url, { unknown: true })).status).toBe(400);
});
