import { expect, it } from 'vitest';
import { seedBook, seedCharacterState, seedForeshadow, seedRelation, seedTimelineEvent } from './helpers';

// ---------- 角色运行时 ----------

it('角色运行时：创建并回读（来源章+原文证据），列表按角色名与章号排列', async () => {
  const env = await createFactsEnv();
  const state = await seedCharacterState(env.request, env.book.id);
  expect(state).toMatchObject({
    bookId: env.book.id,
    name: '陆沉舟',
    chapter: 3,
    category: 'injury',
    content: '左臂经脉尽断，靠玄天宗秘药勉强续上。',
    evidence: '「你这条左臂，三个月内是握不住剑了。」',
  });
  expect(state.id).toBeGreaterThan(0);

  const later = await seedCharacterState(env.request, env.book.id, { name: '陆沉舟', chapter: 7, content: '伤势痊愈。' });
  const other = await seedCharacterState(env.request, env.book.id, { name: '白凝霜', chapter: 5, category: 'other' });

  const list = await env.request.get(`/api/books/${env.book.id}/facts/characters`);
  expect(list.status).toBe(200);
  expect(list.body.items.map((s: { name: string; chapter: number }) => `${s.name}@${s.chapter}`)).toEqual([
    '白凝霜@5',
    '陆沉舟@7',
    '陆沉舟@3',
  ]);
  expect(list.body.total).toBe(3);
  expect(later.updatedAt).toBeTruthy();
  expect(other.category).toBe('other');
});

it('角色运行时：PATCH 部分更新；空更新/不存在/跨书/书不存在分别报错', async () => {
  const env = await createFactsEnv();
  const otherBook = await seedBook(env.request, { title: '别的书' });
  const state = await seedCharacterState(env.request, env.book.id);

  const patched = await env.request.patch(`/api/books/${env.book.id}/facts/characters/${state.id}`, {
    content: '伤势反复，寒毒未清。',
    chapter: 4,
  });
  expect(patched.status).toBe(200);
  expect(patched.body).toMatchObject({ name: state.name, chapter: 4, content: '伤势反复，寒毒未清。', category: state.category });

  expect((await env.request.patch(`/api/books/${env.book.id}/facts/characters/${state.id}`, {})).status).toBe(400);
  expect((await env.request.patch(`/api/books/${env.book.id}/facts/characters/999`, { content: 'x' })).status).toBe(404);
  expect((await env.request.patch(`/api/books/${otherBook.id}/facts/characters/${state.id}`, { content: 'x' })).status).toBe(404);
  expect((await env.request.patch(`/api/books/999/facts/characters/${state.id}`, { content: 'x' })).status).toBe(404);
  expect((await env.request.patch(`/api/books/${env.book.id}/facts/characters/${state.id}`, { status: 'locked' })).status).toBe(400);

  expect((await env.request.delete(`/api/books/${env.book.id}/facts/characters/${state.id}`)).status).toBe(204);
  expect((await env.request.delete(`/api/books/${env.book.id}/facts/characters/${state.id}`)).status).toBe(404);
});

it('角色运行时：校验失败返回 400（缺字段/空白/非法类别/章节非正整数/超长）', async () => {
  const env = await createFactsEnv();
  const base = `/api/books/${env.book.id}/facts/characters`;

  expect((await env.request.post(base, { name: '陆沉舟', chapter: 3 })).status).toBe(400);
  expect((await env.request.post(base, { name: '  ', chapter: 3, category: 'injury', content: 'c', evidence: 'e' })).status).toBe(400);
  expect((await env.request.post(base, { name: '陆沉舟', chapter: 3, category: 'mood', content: 'c', evidence: 'e' })).status).toBe(400);
  expect((await env.request.post(base, { name: '陆沉舟', chapter: 0, category: 'injury', content: 'c', evidence: 'e' })).status).toBe(400);
  expect((await env.request.post(base, { name: '陆沉舟', chapter: 1.5, category: 'injury', content: 'c', evidence: 'e' })).status).toBe(400);
  expect((await env.request.post(base, { name: '陆沉舟', chapter: 3, category: 'injury', content: '', evidence: 'e' })).status).toBe(400);
  expect((await env.request.post(base, { name: '陆沉舟', chapter: 3, category: 'injury', content: 'c', evidence: '' })).status).toBe(400);
  expect((await env.request.post(base, { name: '陆沉舟', chapter: 3, category: 'injury', content: 'c'.repeat(20_001), evidence: 'e' })).status).toBe(400);
  expect((await env.request.post(`${base}`, { name: 'x', chapter: 3, category: 'injury', content: 'c', evidence: 'e', extra: 1 })).status).toBe(400);
  expect((await env.request.post(`/api/books/999/facts/characters`, { name: 'x', chapter: 3, category: 'injury', content: 'c', evidence: 'e' })).status).toBe(404);
});

// ---------- 人物关系 ----------

it('人物关系：创建/列表/PATCH/DELETE，来自章与证据齐备', async () => {
  const env = await createFactsEnv();
  const edge = await seedRelation(env.request, env.book.id);
  expect(edge).toMatchObject({
    bookId: env.book.id,
    fromName: '陆沉舟',
    toName: '玄阳真人',
    relation: '师徒',
    chapter: 3,
    evidence: '「拜师礼毕，你便是我玄阳一脉的关门弟子。」',
  });

  const another = await seedRelation(env.request, env.book.id, { fromName: '白凝霜', toName: '陆沉舟', relation: '同门' });
  const list = await env.request.get(`/api/books/${env.book.id}/facts/relations`);
  expect(list.body.total).toBe(2);
  expect(list.body.items[0]).toMatchObject({ fromName: '白凝霜', relation: '同门' });

  const patched = await env.request.patch(`/api/books/${env.book.id}/facts/relations/${edge.id}`, { relation: '师徒（已决裂）' });
  expect(patched.status).toBe(200);
  expect(patched.body.relation).toBe('师徒（已决裂）');
  expect(patched.body.fromName).toBe(edge.fromName);

  expect((await env.request.post(`/api/books/${env.book.id}/facts/relations`, { fromName: 'a', toName: 'b' })).status).toBe(400);
  expect((await env.request.post(`/api/books/${env.book.id}/facts/relations`, { fromName: 'a', toName: 'b', relation: 'r', chapter: 1, evidence: '' })).status).toBe(400);
  expect((await env.request.patch(`/api/books/${env.book.id}/facts/relations/999`, { relation: 'x' })).status).toBe(404);
  expect((await env.request.delete(`/api/books/${env.book.id}/facts/relations/${another.id}`)).status).toBe(204);
});

// ---------- 时间轴 ----------

it('时间轴：创建/列表按章号升序/PATCH/DELETE', async () => {
  const env = await createFactsEnv();
  const late = await seedTimelineEvent(env.request, env.book.id, { chapter: 9, title: '宗门大比' });
  const early = await seedTimelineEvent(env.request, env.book.id, { chapter: 2, title: '测灵大典' });

  const list = await env.request.get(`/api/books/${env.book.id}/facts/timeline`);
  expect(list.body.items.map((e: { title: string }) => e.title)).toEqual(['测灵大典', '宗门大比']);
  expect(early.content).toBeTruthy();
  expect(late.evidence).toBeTruthy();

  const patched = await env.request.patch(`/api/books/${env.book.id}/facts/timeline/${late.id}`, { chapter: 1 });
  expect(patched.status).toBe(200);
  expect(patched.body.chapter).toBe(1);
  expect(patched.body.title).toBe(late.title);

  expect((await env.request.patch(`/api/books/${env.book.id}/facts/timeline/${late.id}`, {})).status).toBe(400);
  expect((await env.request.delete(`/api/books/${env.book.id}/facts/timeline/${late.id}`)).status).toBe(204);
});

// ---------- 伏笔账本：CRUD 与超期预警 ----------

it('伏笔：创建默认 planted，带埋设章/目标章/证据；目标章早于埋设章被拒', async () => {
  const env = await createFactsEnv();
  const f = await seedForeshadow(env.request, env.book.id);
  expect(f).toMatchObject({
    bookId: env.book.id,
    title: '残玉中的低语',
    status: 'planted',
    plantedChapter: 1,
    targetChapter: 12,
    evidence: '玉佩贴肉的地方，忽然烫了一下。',
  });

  const list = await env.request.get(`/api/books/${env.book.id}/facts/foreshadows`);
  expect(list.body.total).toBe(1);

  expect(
    (await env.request.post(`/api/books/${env.book.id}/facts/foreshadows`, { title: 'x', targetChapter: 5, evidence: 'e' })).status
  ).toBe(400);
  expect(
    (await env.request.post(`/api/books/${env.book.id}/facts/foreshadows`, { title: 'x', plantedChapter: 1, targetChapter: 5, evidence: 'e', status: 'resolved' })).status
  ).toBe(400);
  // 时序守卫：目标章不能早于埋设章（创建与编辑均拒绝）
  const base = `/api/books/${env.book.id}/facts/foreshadows`;
  expect(
    (await env.request.post(base, { title: 'x', plantedChapter: 5, targetChapter: 3, evidence: 'e' })).status
  ).toBe(400);
  // PATCH 与现有值合并后校验：把埋设章改到目标章之后
  expect((await env.request.patch(`${base}/${f.id}`, { plantedChapter: 20 })).status).toBe(400);
});

it('超期预警：仅 planted/progressing 且目标章严格小于当前章时 overdue=true', async () => {
  const env = await createFactsEnv();
  const overduePlanted = await seedForeshadow(env.request, env.book.id, { title: '超期-埋设', plantedChapter: 1, targetChapter: 5 });
  const overdueProgressing = await seedForeshadow(env.request, env.book.id, { title: '超期-推进', plantedChapter: 2, targetChapter: 6 });
  const boundary = await seedForeshadow(env.request, env.book.id, { title: '压线', plantedChapter: 1, targetChapter: 10 });
  const resolved = await seedForeshadow(env.request, env.book.id, { title: '已回收', plantedChapter: 1, targetChapter: 4 });

  // 把「超期-推进」推进到 progressing，「已回收」回收
  await env.request.post(`/api/books/${env.book.id}/facts/foreshadows/${overdueProgressing.id}/status`, { status: 'progressing' });
  await env.request.post(`/api/books/${env.book.id}/facts/foreshadows/${resolved.id}/status`, { status: 'resolved' });

  const res = await env.request.get(`/api/books/${env.book.id}/facts/foreshadows?currentChapter=10`);
  const byTitle = new Map<string, { overdue: boolean; status: string }>(
    res.body.items.map((item: { title: string; overdue: boolean; status: string }) => [item.title, { overdue: item.overdue, status: item.status }])
  );
  expect(byTitle.get('超期-埋设')).toEqual({ overdue: true, status: 'planted' });
  expect(byTitle.get('超期-推进')).toEqual({ overdue: true, status: 'progressing' });
  expect(byTitle.get('压线')).toEqual({ overdue: false, status: 'planted' });
  expect(byTitle.get('已回收')).toEqual({ overdue: false, status: 'resolved' });

  // 不带当前章：一律不判预警
  const plain = await env.request.get(`/api/books/${env.book.id}/facts/foreshadows`);
  for (const item of plain.body.items) expect(item.overdue).toBe(false);

  // 非法当前章
  expect((await env.request.get(`/api/books/${env.book.id}/facts/foreshadows?currentChapter=abc`)).status).toBe(400);
  expect((await env.request.get(`/api/books/${env.book.id}/facts/foreshadows?currentChapter=0`)).status).toBe(400);
});

it('伏笔 PATCH 可改标题/详情/目标章/证据，不可经 PATCH 改状态', async () => {
  const env = await createFactsEnv();
  const f = await seedForeshadow(env.request, env.book.id);

  const patched = await env.request.patch(`/api/books/${env.book.id}/facts/foreshadows/${f.id}`, {
    title: '残玉低语（改）',
    targetChapter: 20,
  });
  expect(patched.status).toBe(200);
  expect(patched.body).toMatchObject({ title: '残玉低语（改）', targetChapter: 20, status: 'planted', plantedChapter: f.plantedChapter });

  expect((await env.request.patch(`/api/books/${env.book.id}/facts/foreshadows/${f.id}`, { status: 'resolved' })).status).toBe(400);
  expect((await env.request.patch(`/api/books/${env.book.id}/facts/foreshadows/${f.id}`, {})).status).toBe(400);
  expect((await env.request.patch(`/api/books/${env.book.id}/facts/foreshadows/999`, { title: 'x' })).status).toBe(404);
});

// ---------- 伏笔状态机 ----------

it('合法流转：planted→progressing→resolved；planted→resolved 直接回收；planted→abandoned 亦可', async () => {
  const env = await createFactsEnv();
  const f = await seedForeshadow(env.request, env.book.id);
  const url = `/api/books/${env.book.id}/facts/foreshadows/${f.id}/status`;

  expect((await env.request.post(url, { status: 'progressing' })).body.status).toBe('progressing');
  expect((await env.request.post(url, { status: 'resolved' })).body.status).toBe('resolved');

  // 不经 progressing 直接回收同样合法
  const direct = await seedForeshadow(env.request, env.book.id, { title: '直接回收的伏笔' });
  expect(
    (await env.request.post(`/api/books/${env.book.id}/facts/foreshadows/${direct.id}/status`, { status: 'resolved' })).body.status
  ).toBe('resolved');

  const other = await seedForeshadow(env.request, env.book.id, { title: '注定放弃的伏笔' });
  expect((await env.request.post(`/api/books/${env.book.id}/facts/foreshadows/${other.id}/status`, { status: 'abandoned' })).body.status).toBe('abandoned');

  const reread = await env.request.get(`/api/books/${env.book.id}/facts/foreshadows`);
  const statuses = Object.fromEntries(reread.body.items.map((item: { title: string; status: string }) => [item.title, item.status]));
  expect(statuses).toMatchObject({
    '残玉中的低语': 'resolved',
    '直接回收的伏笔': 'resolved',
    '注定放弃的伏笔': 'abandoned',
  });
});

it('非法流转一律拒绝（409）：回退/终态再动/同态；未知目标值 400', async () => {
  const env = await createFactsEnv();
  const f = await seedForeshadow(env.request, env.book.id);
  const url = `/api/books/${env.book.id}/facts/foreshadows/${f.id}/status`;

  // planted 同态非法
  expect((await env.request.post(url, { status: 'planted' })).status).toBe(409);

  await env.request.post(url, { status: 'progressing' });
  // progressing 回退 planted 非法；放弃合法
  expect((await env.request.post(url, { status: 'planted' })).status).toBe(409);
  expect((await env.request.post(url, { status: 'abandoned' })).status).toBe(200);

  // abandoned 是终态：一切再流转均拒绝
  expect((await env.request.post(url, { status: 'planted' })).status).toBe(409);
  expect((await env.request.post(url, { status: 'progressing' })).status).toBe(409);
  expect((await env.request.post(url, { status: 'abandoned' })).status).toBe(409);

  // resolved 同为终态
  const resolved = await seedForeshadow(env.request, env.book.id, { title: '已回收的伏笔' });
  const resolvedUrl = `/api/books/${env.book.id}/facts/foreshadows/${resolved.id}/status`;
  await env.request.post(resolvedUrl, { status: 'resolved' });
  expect((await env.request.post(resolvedUrl, { status: 'progressing' })).status).toBe(409);
  expect((await env.request.post(resolvedUrl, { status: 'resolved' })).status).toBe(409);

  expect((await env.request.post(url, { status: 'unknown' })).status).toBe(400);
  expect((await env.request.post(url, {})).status).toBe(400);
  expect((await env.request.post(`/api/books/${env.book.id}/facts/foreshadows/999/status`, { status: 'resolved' })).status).toBe(404);
});

// ---------- 级联 ----------

it('删除书级联清理四表', async () => {
  const env = await createFactsEnv();
  await seedCharacterState(env.request, env.book.id);
  await seedRelation(env.request, env.book.id);
  await seedTimelineEvent(env.request, env.book.id);
  await seedForeshadow(env.request, env.book.id);

  expect((await env.request.delete(`/api/books/${env.book.id}`)).status).toBe(204);
  for (const table of ['character_states', 'character_relations', 'timeline_events', 'foreshadows']) {
    const row = env.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    expect(row.count).toBe(0);
  }
});

// ---------- 局部辅助 ----------

import { createTestApp, type TestBook } from './helpers';

async function createFactsEnv(): Promise<{ request: ReturnType<typeof createTestApp>['request']; db: ReturnType<typeof createTestApp>['db']; book: TestBook }> {
  const env = createTestApp();
  const book = await seedBook(env.request, { title: '事实库测试书' });
  return { request: env.request, db: env.db, book };
}
