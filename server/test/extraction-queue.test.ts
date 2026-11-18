import { expect, it } from 'vitest';
import { LLMError } from '../src/llm/types';
import { configureRoute, createTestApp, extractResult, extractQueue, seedMaterial, seedReference, type TestExtractionItem } from './helpers';

const CHAPTER_1_ITEMS = [
  { type: 'setting', title: '玄天宗', content: '北境头号宗门，掌门陆沉舟。', payload: { category: '势力' } },
  { type: 'trope', title: '灭门开局', content: '主角开场被卷入灭门之祸。', payload: { structure: '危机前置' } },
  { type: 'style', title: '雪夜行军', content: '风雪掠过旷野，他勒住缰绳。', payload: { rhythm: '短句为主' } },
];

it('未配置 extract 路由时抽取返回 409', async () => {
  const env = createTestApp();
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲章正文。' }]);
  const res = await env.request.post(`/api/references/${reference.id}/extract`, { limit: 1 });
  expect(res.status).toBe(409);
  expect(res.body.error).toContain('extract');
});

it('FakeLLM 脚本化响应抽取单章：条目入队、章节标记完成、溯源上下文进入 prompt', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [
    { title: '第一章 北境', content: '北境的雪原上，少年第一次握剑。' },
    { title: '第二章 入宗', content: '宗门大比在即。' },
  ]);
  env.llm.script.respondSequence = { extract: [extractResult(CHAPTER_1_ITEMS)] };

  const run = await env.request.post(`/api/references/${reference.id}/extract`, { limit: 1 });
  expect(run.status).toBe(200);
  expect(run.body.processed).toHaveLength(1);
  expect(run.body.processed[0]).toMatchObject({ chapterTitle: '第一章 北境', itemCount: 3 });
  expect(run.body.failed).toEqual([]);
  expect(run.body.remaining).toBe(1);

  // LLM 接缝：任务为 extract，prompt 携带章节标题与正文
  expect(env.llm.calls).toHaveLength(1);
  expect(env.llm.calls[0]!.task).toBe('extract');
  expect(env.llm.calls[0]!.req.messages.some((m) => m.content.includes('第一章 北境'))).toBe(true);
  expect(env.llm.calls[0]!.req.messages.some((m) => m.content.includes('北境的雪原'))).toBe(true);

  // 章节状态与队列
  const detail = (await env.request.get(`/api/references/${reference.id}`)).body;
  expect(detail.chapters[0]!.extractStatus).toBe('done');
  expect(detail.chapters[1]!.extractStatus).toBe('pending');

  const queue = await extractQueue(env.request, reference.id, 'pending');
  expect(queue.total).toBe(3);
  expect(queue.items.map((i: TestExtractionItem) => [i.type, i.title])).toEqual([
    ['setting', '玄天宗'],
    ['trope', '灭门开局'],
    ['style', '雪夜行军'],
  ]);
  expect(queue.items.every((i: TestExtractionItem) => i.chapterTitle === '第一章 北境')).toBe(true);
  expect(queue.items.every((i: TestExtractionItem) => i.conflict === null && i.status === 'pending')).toBe(true);
});

it('大文件分章后抽取可断点续跑：limit 控制批量，失败章节保持 pending 可重试', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [
    { title: '第一章 甲', content: '甲。' },
    { title: '第二章 乙', content: '乙。' },
    { title: '第三章 丙', content: '丙。' },
  ]);
  env.llm.script.respondSequence = {
    extract: [extractResult(CHAPTER_1_ITEMS), extractResult([]), new LLMError('模拟供应商超时')],
  };

  const first = await env.request.post(`/api/references/${reference.id}/extract`, { limit: 3 });
  expect(first.status).toBe(200);
  expect(first.body.processed.map((p: { chapterTitle: string }) => p.chapterTitle)).toEqual(['第一章 甲', '第二章 乙']);
  expect(first.body.failed).toEqual([{ chapterId: first.body.failed[0]!.chapterId, chapterTitle: '第三章 丙', error: expect.stringContaining('超时') }]);
  expect(first.body.remaining).toBe(1);

  // 断点续跑：只有失败章仍 pending，补脚本后单独重试成功
  env.llm.script.respondSequence = { extract: [extractResult([{ type: 'setting', title: '丙章设定', content: '丙章内容。' }])] };
  const retry = await env.request.post(`/api/references/${reference.id}/extract`, {});
  expect(retry.status).toBe(200);
  expect(retry.body.processed).toHaveLength(1);
  expect(retry.body.remaining).toBe(0);

  const detail = (await env.request.get(`/api/references/${reference.id}`)).body;
  expect(detail.chapters.every((c: { extractStatus: string }) => c.extractStatus === 'done')).toBe(true);
  expect(((await env.request.get('/api/references')).body as { items: { extractedCount: number }[] }).items[0]!.extractedCount).toBe(3);
});

it('LLM 返回非法 JSON 时该章失败且保持 pending', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲。' }]);
  env.llm.script.respondSequence = { extract: [{ content: '这不是 JSON', model: 'fake' }] };

  const run = await env.request.post(`/api/references/${reference.id}/extract`, {});
  expect(run.status).toBe(200);
  expect(run.body.processed).toEqual([]);
  expect(run.body.failed[0]!.error).toContain('JSON');
  expect(((await env.request.get(`/api/references/${reference.id}`)).body as { chapters: { extractStatus: string }[] }).chapters[0]!.extractStatus).toBe('pending');
});

it('LLM 条目混入非法项时仅丢弃非法项', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲。' }]);
  env.llm.script.respondSequence = {
    extract: [
      extractResult([
        ...CHAPTER_1_ITEMS.slice(0, 1),
        { type: 'plot', title: '未知类型', content: 'x' }, // 未知类型 → 丢弃
        { type: 'setting', title: '   ', content: '空标题' }, // 空标题 → 丢弃
        { type: 'setting', title: 'payload 非法', content: 'x', payload: { unknownKey: 'v', category: '人物' } }, // 未知 payload 键被剥除
        '不是对象', // 非对象 → 丢弃
      ]),
    ],
  };

  const run = await env.request.post(`/api/references/${reference.id}/extract`, {});
  expect(run.body.processed[0]!.itemCount).toBe(2);
  const queue = await extractQueue(env.request, reference.id, 'pending');
  const cleaned = queue.items[1] as TestExtractionItem;
  expect(cleaned.title).toBe('payload 非法');
  expect(cleaned.payload).toEqual({ category: '人物' });
});

it('确认入库自动带出处溯源，确认后条目归档', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [{ title: '第一章 北境', content: '北境的雪。' }], '《参考书甲》');
  env.llm.script.respondSequence = { extract: [extractResult(CHAPTER_1_ITEMS)] };
  await env.request.post(`/api/references/${reference.id}/extract`, {});

  const queue = await extractQueue(env.request, reference.id, 'pending');
  const item = queue.items[0] as TestExtractionItem;

  const accepted = await env.request.post(`/api/extractions/${item.id}/accept`, {});
  expect(accepted.status).toBe(200);
  expect(accepted.body).toMatchObject({ status: 'accepted', resolution: 'new', materialId: accepted.body.materialId });
  expect(accepted.body.materialId).toBeGreaterThan(0);

  const material = await env.request.get(`/api/materials/${accepted.body.materialId}`);
  expect(material.status).toBe(200);
  expect(material.body).toMatchObject({
    type: 'setting',
    title: '玄天宗',
    payload: { category: '势力' },
    source: { kind: 'reference', book: '《参考书甲》', chapter: '第一章 北境' },
  });

  const afterQueue = await extractQueue(env.request, reference.id, 'pending');
  expect(afterQueue.total).toBe(2);
  expect((await extractQueue(env.request, reference.id, 'accepted')).total).toBe(1);
});

it('确认前可修改条目字段（按类型校验）', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲。' }]);
  env.llm.script.respondSequence = { extract: [extractResult([{ type: 'setting', title: '原题', content: '原文。', payload: { category: '势力' } }])] };
  await env.request.post(`/api/references/${reference.id}/extract`, {});
  const item = (await extractQueue(env.request, reference.id, 'pending')).items[0] as TestExtractionItem;

  expect((await env.request.patch(`/api/extractions/${item.id}`, { payload: { unknownKey: 'x' } })).status).toBe(400);

  const patched = await env.request.patch(`/api/extractions/${item.id}`, {
    title: '玄天宗（修订）',
    content: '修订后的介绍。',
    payload: { category: '人物' },
  });
  expect(patched.status).toBe(200);
  expect(patched.body).toMatchObject({ title: '玄天宗（修订）', payload: { category: '人物' } });
});

it('确认前修改 payload 按键合并：skeleton 只改一键不丢其余键', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲。' }]);
  env.llm.script.respondSequence = {
    extract: [
      extractResult([
        {
          type: 'skeleton',
          title: '废柴流骨骼',
          content: '黄金三章开局。',
          payload: { pacingCurve: '缓起陡升', volumeStructure: '四卷结构', archetypes: '隐忍主角' },
        },
      ]),
    ],
  };
  await env.request.post(`/api/references/${reference.id}/extract`, {});
  const item = (await extractQueue(env.request, reference.id, 'pending')).items[0] as TestExtractionItem;

  const patched = await env.request.patch(`/api/extractions/${item.id}`, { payload: { pacingCurve: '压缩开局' } });
  expect(patched.status).toBe(200);
  expect(patched.body.payload).toEqual({
    pacingCurve: '压缩开局',
    volumeStructure: '四卷结构',
    archetypes: '隐忍主角',
  });
});

it('重名素材触发去重：未选择处理方式 409，三种处理方式均生效', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const existing = await seedMaterial(env.request, { type: 'setting', title: '玄天宗', payload: { category: '势力' } });
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲。' }]);
  env.llm.script.respondSequence = {
    extract: [extractResult([{ type: 'setting', title: '玄天宗', content: '拆书新发现：宗门密道。', payload: {} }])],
  };
  await env.request.post(`/api/references/${reference.id}/extract`, {});
  const item = (await extractQueue(env.request, reference.id, 'pending')).items[0] as TestExtractionItem;

  // 队列里给出碰撞提示
  expect(item.conflict).toMatchObject({ materialId: existing.id, title: '玄天宗' });

  // 未选择处理方式 → 409
  const noResolution = await env.request.post(`/api/extractions/${item.id}/accept`, {});
  expect(noResolution.status).toBe(409);
  expect(noResolution.body.error).toContain('重名');

  // skip：不入库
  const skipped = await env.request.post(`/api/extractions/${item.id}/accept`, { resolution: 'skip' });
  expect(skipped.status).toBe(200);
  expect(skipped.body).toMatchObject({ status: 'accepted', resolution: 'skip', materialId: null });
  expect(((await env.request.get('/api/materials?type=setting')).body as { total: number }).total).toBe(1);
});

it('resolution=new 允许同名新建第二条素材', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  await seedMaterial(env.request, { type: 'setting', title: '玄天宗' });
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲。' }]);
  env.llm.script.respondSequence = {
    extract: [extractResult([{ type: 'setting', title: '玄天宗', content: '另一个平行世界的玄天宗。' }])],
  };
  await env.request.post(`/api/references/${reference.id}/extract`, {});
  const item = (await extractQueue(env.request, reference.id, 'pending')).items[0] as TestExtractionItem;

  const accepted = await env.request.post(`/api/extractions/${item.id}/accept`, { resolution: 'new' });
  expect(accepted.status).toBe(200);
  expect(accepted.body.materialId).not.toBe(null);
  expect(((await env.request.get('/api/materials?type=setting')).body as { total: number }).total).toBe(2);
});

it('resolution=merge 追加内容、补齐 payload 缺键并把人工溯源升级为参考书溯源', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const existing = await seedMaterial(env.request, {
    type: 'setting',
    title: '玄天宗',
    content: '北境头号宗门。',
    payload: { category: '势力' },
    source: { kind: 'manual' },
    tags: ['宗门'],
  });
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲。' }]);
  env.llm.script.respondSequence = {
    extract: [extractResult([{ type: 'setting', title: '玄天宗', content: '拆书补充：宗门另有密道直通后山。', payload: {} }])],
  };
  await env.request.post(`/api/references/${reference.id}/extract`, {});
  const item = (await extractQueue(env.request, reference.id, 'pending')).items[0] as TestExtractionItem;

  const accepted = await env.request.post(`/api/extractions/${item.id}/accept`, { resolution: 'merge' });
  expect(accepted.status).toBe(200);
  expect(accepted.body.materialId).toBe(existing.id);

  const merged = await env.request.get(`/api/materials/${existing.id}`);
  expect(merged.status).toBe(200);
  expect(merged.body.content).toContain('北境头号宗门。');
  expect(merged.body.content).toContain('宗门另有密道');
  expect(merged.body.content).toContain('（拆书出处：参考书·拆书测试 第一章 甲）'); // 合并路径的行内溯源标注
  expect(merged.body.payload).toEqual({ category: '势力' });
  expect(merged.body.source).toEqual({ kind: 'reference', book: '参考书·拆书测试', chapter: '第一章 甲' });
  expect(merged.body.tags).toEqual(['宗门']);
  expect(((await env.request.get('/api/materials?type=setting')).body as { total: number }).total).toBe(1);
});

it('拒绝条目后不再出现在待确认队列；重复处理已归档条目报错', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲。' }]);
  env.llm.script.respondSequence = { extract: [extractResult(CHAPTER_1_ITEMS)] };
  await env.request.post(`/api/references/${reference.id}/extract`, {});
  const queue = await extractQueue(env.request, reference.id, 'pending');
  const item = queue.items[0] as TestExtractionItem;

  expect((await env.request.post(`/api/extractions/${item.id}/reject`, {})).status).toBe(200);
  expect((await extractQueue(env.request, reference.id, 'pending')).total).toBe(2);
  expect((await extractQueue(env.request, reference.id, 'rejected')).total).toBe(1);

  expect((await env.request.post(`/api/extractions/${item.id}/accept`, { resolution: 'skip' })).status).toBe(409);
  expect((await env.request.patch(`/api/extractions/${item.id}`, { title: 'x' })).status).toBe(409);
  expect((await env.request.post(`/api/extractions/999/accept`, { resolution: 'skip' })).status).toBe(404);
});
