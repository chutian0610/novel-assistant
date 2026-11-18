import { expect, it } from 'vitest';
import { configureRoute, createTestApp, extractQueue, extractResult, seedMaterial, seedReference, type TestExtractionItem } from './helpers';

const SKELETON_PAYLOAD = {
  pacingCurve: '黄金三章开局，随后放缓',
  volumeStructure: '四卷：宗门/游历/夺嫡/终战',
  archetypes: '隐忍主角+严厉师尊',
};

/** 全书骨骼提取 → 确认入库，返回（参考书，已入库骨骼素材 id） */
async function seedConfirmedSkeleton(env: ReturnType<typeof createTestApp>) {
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [{ title: '第一章 宗门', content: '宗门试炼开场。' }]);
  env.llm.script.respondSequence = {
    extract: [extractResult([{ type: 'skeleton', title: '宗门流骨骼', content: '以宗门试炼做第一卷骨架。', payload: SKELETON_PAYLOAD }])],
  };
  await env.request.post(`/api/references/${reference.id}/extract-skeleton`, {});
  const item = (await extractQueue(env.request, reference.id, 'pending')).items[0] as TestExtractionItem;
  const accepted = await env.request.post(`/api/extractions/${item.id}/accept`, {});
  return { reference, materialId: accepted.body.materialId as number };
}

it('单章抽取的 skeleton 三键不齐时丢弃，齐全时入队（结构完整契约）', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲。' }]);
  env.llm.script.respondSequence = {
    extract: [
      extractResult([
        { type: 'skeleton', title: '缺键骨骼', content: 'x', payload: { pacingCurve: '只有曲线' } },
        { type: 'skeleton', title: '完整骨骼', content: '全书从宗门试炼推向夺嫡终战。', payload: SKELETON_PAYLOAD },
      ]),
    ],
  };
  await env.request.post(`/api/references/${reference.id}/extract`, {});

  const queue = await extractQueue(env.request, reference.id, 'pending');
  expect(queue.total).toBe(1);
  expect(queue.items[0]!.title).toBe('完整骨骼');
});

it('全书骨骼提取：全书章节进 prompt，产出「全书」条目进队列', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [
    { title: '第一章 宗门', content: '宗门试炼开场。' },
    { title: '第二章 游历', content: '外出游历遇险。' },
  ]);
  env.llm.script.respondSequence = {
    extract: [extractResult([{ type: 'skeleton', title: '全书骨骼', content: '两卷推进。', payload: SKELETON_PAYLOAD }])],
  };

  const res = await env.request.post(`/api/references/${reference.id}/extract-skeleton`, {});
  expect(res.status).toBe(201);
  const item = res.body as TestExtractionItem;
  expect(item).toMatchObject({ type: 'skeleton', title: '全书骨骼', chapterTitle: '全书', status: 'pending' });
  expect(item.chapterId).toBe(null);

  // prompt 契约：全书章节标题与正文进入上下文
  expect(env.llm.calls[0]!.task).toBe('extract');
  const prompt = env.llm.calls[0]!.req.messages.map((m) => m.content).join('\n');
  expect(prompt).toContain('第一章 宗门');
  expect(prompt).toContain('外出游历遇险');

  const queue = await extractQueue(env.request, reference.id, 'pending');
  expect(queue.items.some((i) => i.id === item.id)).toBe(true);
});

it('全书骨骼提取：已有待确认骨骼时 409；LLM 产出残缺骨骼时 502 且不产生条目', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'extract');
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲。' }]);

  // 残缺骨骼（缺 required 键）→ 502
  env.llm.script.respondSequence = {
    extract: [extractResult([{ type: 'skeleton', title: '残缺', content: 'x', payload: { pacingCurve: 'y' } }])],
  };
  const bad = await env.request.post(`/api/references/${reference.id}/extract-skeleton`, {});
  expect(bad.status).toBe(502);
  expect((await extractQueue(env.request, reference.id, 'pending')).total).toBe(0);

  // 合格骨骼 → 201；重复提取 → 409
  env.llm.script.respondSequence = {
    extract: [extractResult([{ type: 'skeleton', title: '全书骨骼', content: '结构。', payload: SKELETON_PAYLOAD }])],
  };
  expect((await env.request.post(`/api/references/${reference.id}/extract-skeleton`, {})).status).toBe(201);
  const dup = await env.request.post(`/api/references/${reference.id}/extract-skeleton`, {});
  expect(dup.status).toBe(409);
  expect(dup.body.error).toContain('待确认');
});

it('一键仿写：产出全新设定/角色进队列，溯源指向源骨骼，prompt 携带换名禁令', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'outline');
  const { reference, materialId } = await seedConfirmedSkeleton(env);
  env.llm.script.respondSequence = {
    outline: [
      extractResult([
        { type: 'setting', title: '玄冰阁', content: '北境二流宗门，以阵法立派。', payload: { category: '势力' } },
        { type: 'setting', title: '沈孤鸿', content: '外冷内热的少年剑修。', payload: { category: '人物' } },
      ]),
    ],
  };

  const res = await env.request.post(`/api/references/${reference.id}/adapt-skeleton`, { materialId });
  expect(res.status).toBe(201);
  expect((res.body as { created: number }).created).toBe(2);

  // prompt 契约（AC4）：源骨骼方法论注入 + 禁止复述原文 + 要求重新命名
  const outlineCalls = env.llm.calls.filter((c) => c.task === 'outline');
  expect(outlineCalls).toHaveLength(1);
  const prompt = outlineCalls[0]!.req.messages.map((m) => m.content).join('\n');
  expect(prompt).toContain('宗门流骨骼'); // 源骨骼标题
  expect(prompt).toContain('隐忍主角'); // 源骨骼结构字段
  expect(prompt).toContain('不得复述'); // 复述禁令
  expect(prompt).toContain('重新命名'); // 换名要求

  const queue = await extractQueue(env.request, reference.id, 'pending');
  expect(queue.total).toBe(2);
  for (const item of queue.items) {
    expect(item.sourceSkeleton).toMatchObject({ materialId, title: '宗门流骨骼' });
    expect(item.type).toBe('setting');
    expect(item.chapterTitle).toBe('全书');
  }
});

it('仿写条目确认入库：溯源 chapter=仿写自《源骨骼标题》', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'outline');
  const { reference, materialId } = await seedConfirmedSkeleton(env);
  env.llm.script.respondSequence = {
    outline: [extractResult([{ type: 'setting', title: '沈孤鸿', content: '少年剑修。', payload: { category: '人物' } }])],
  };
  await env.request.post(`/api/references/${reference.id}/adapt-skeleton`, { materialId });
  const item = (await extractQueue(env.request, reference.id, 'pending')).items[0] as TestExtractionItem;

  const accepted = await env.request.post(`/api/extractions/${item.id}/accept`, {});
  expect(accepted.status).toBe(200);
  const material = await env.request.get(`/api/materials/${accepted.body.materialId}`);
  expect(material.status).toBe(200);
  expect(material.body).toMatchObject({
    type: 'setting',
    title: '沈孤鸿',
    source: { kind: 'reference', book: '参考书·拆书测试', chapter: '仿写自《宗门流骨骼》' },
  });
});

it('仿写产出与全局素材重名时给出碰撞提示；不冲突的原创名可直接入库（AC2）', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'outline');
  await seedMaterial(env.request, { type: 'setting', title: '玄冰阁' }); // 全局已有同名势力
  const { reference, materialId } = await seedConfirmedSkeleton(env);
  env.llm.script.respondSequence = {
    outline: [
      extractResult([
        { type: 'setting', title: '玄冰阁', content: '撞名的宗门。', payload: { category: '势力' } },
        { type: 'setting', title: '云隐涧', content: '原创地名。', payload: { category: '地点' } },
      ]),
    ],
  };
  await env.request.post(`/api/references/${reference.id}/adapt-skeleton`, { materialId });
  const queue = await extractQueue(env.request, reference.id, 'pending');
  const items = queue.items as TestExtractionItem[];
  expect(items.find((i) => i.title === '玄冰阁')!.conflict).not.toBe(null);
  expect(items.find((i) => i.title === '云隐涧')!.conflict).toBe(null);

  const clash = items.find((i) => i.title === '玄冰阁')!;
  expect((await env.request.post(`/api/extractions/${clash.id}/accept`, {})).status).toBe(409);
  const original = items.find((i) => i.title === '云隐涧')!;
  expect((await env.request.post(`/api/extractions/${original.id}/accept`, {})).status).toBe(200);
});

it('仿写校验：素材不存在 404 / 非 skeleton 400 / outline 路由未配置 409', async () => {
  const env = createTestApp();
  await configureRoute(env.request, 'outline');
  const reference = await seedReference(env.request, [{ title: '第一章 甲', content: '甲。' }]);

  expect((await env.request.post(`/api/references/${reference.id}/adapt-skeleton`, { materialId: 999 })).status).toBe(404);

  const notSkeleton = await seedMaterial(env.request, { type: 'setting' });
  const wrongType = await env.request.post(`/api/references/${reference.id}/adapt-skeleton`, { materialId: notSkeleton.id });
  expect(wrongType.status).toBe(400);
  expect(wrongType.body.error).toContain('书骨骼');

  // outline 路由未配置 → 仿写 409（素材本身存在且是书骨骼）
  const env2 = createTestApp();
  await configureRoute(env2.request, 'extract');
  const skeletonMaterial = await seedMaterial(env2.request, { type: 'skeleton' });
  const reference2 = await seedReference(env2.request, [{ title: '第一章 甲', content: '甲。' }]);
  const noOutline = await env2.request.post(`/api/references/${reference2.id}/adapt-skeleton`, {
    materialId: skeletonMaterial.id,
  });
  expect(noOutline.status).toBe(409);
  expect(noOutline.body.error).toContain('outline');

  // extract 路由未配置 → 全书骨骼提取 409
  const env3 = createTestApp();
  const reference3 = await seedReference(env3.request, [{ title: '第一章 甲', content: '甲。' }]);
  const noExtract = await env3.request.post(`/api/references/${reference3.id}/extract-skeleton`, {});
  expect(noExtract.status).toBe(409);
  expect(noExtract.body.error).toContain('extract');
});
