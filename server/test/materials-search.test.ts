import { expect, it } from 'vitest';
import { createTestApp, seedMaterial, type TestEnv } from './helpers';

async function search(env: TestEnv, q: string): Promise<{ titles: string[]; total: number }> {
  const res = await env.request.get(`/api/materials?q=${encodeURIComponent(q)}`);
  expect(res.status).toBe(200);
  const body = res.body as { items: { title: string }[]; total: number };
  return { titles: body.items.map((m) => m.title), total: body.total };
}

it('中文全文搜索可命中正文（词语级）', async () => {
  const env = createTestApp();
  await seedMaterial(env.request, {
    type: 'style',
    title: '雪原行军',
    content: '风雪掠过旷野，主角在北境雪原遭遇伏击，随行护卫折损过半。',
  });

  expect(await search(env, '伏击')).toEqual({ titles: ['雪原行军'], total: 1 });
  expect(await search(env, '雪原')).toEqual({ titles: ['雪原行军'], total: 1 });
  // 无命中
  expect(await search(env, '宫廷')).toEqual({ titles: [], total: 0 });
});

it('标题、标签与结构化字段均可命中', async () => {
  const env = createTestApp();
  await seedMaterial(env.request, { type: 'skeleton' }); // payload.pacingCurve 含「黄金三章」

  expect((await search(env, '废柴流')).total).toBe(1); // 标题
  expect((await search(env, '黄金')).total).toBe(1); // payload 字段
  expect((await search(env, '测试')).total).toBe(1); // 标签
});

it('多词查询为 AND 语义；纯标点查询忽略搜索条件', async () => {
  const env = createTestApp();
  await seedMaterial(env.request, { type: 'setting', title: '宗门甲' });
  await seedMaterial(env.request, { type: 'trope', title: '宗门乙' });

  // 两词都命中的素材只有对应那条；跨素材组合无命中
  expect(await search(env, '宗门 甲')).toEqual({ titles: ['宗门甲'], total: 1 });
  expect(await search(env, '宗门 甲 乙')).toEqual({ titles: [], total: 0 });

  // 纯标点分不出词 → 忽略搜索条件，返回全部
  expect((await search(env, '！！！？？')).total).toBe(2);
});

it('搜索与类型/标签过滤可组合', async () => {
  const env = createTestApp();
  await seedMaterial(env.request, { type: 'setting', title: '伏击之地', tags: ['场景'] });
  await seedMaterial(env.request, { type: 'trope', title: '伏击桥段' });

  const combined = (await env.request.get('/api/materials?q=伏击&type=setting')).body as {
    total: number;
    items: { title: string }[];
  };
  expect(combined.total).toBe(1);
  expect(combined.items[0]!.title).toBe('伏击之地');

  const tagAndQuery = (await env.request.get('/api/materials?q=伏击&tag=场景')).body as { total: number };
  expect(tagAndQuery.total).toBe(1);
});

it('更新后索引同步：新词命中、旧词失效；删除后不再命中', async () => {
  const env = createTestApp();
  const material = await seedMaterial(env.request, {
    type: 'style',
    content: '主角在北境雪原遭遇伏击。',
  });
  expect((await search(env, '伏击')).total).toBe(1);

  await env.request.patch(`/api/materials/${material.id}`, { content: '主角在南方水乡泛舟赏荷。' });
  expect(await search(env, '伏击')).toEqual({ titles: [], total: 0 });
  expect(await search(env, '赏荷')).toEqual({ titles: ['雪原行军'], total: 1 });

  await env.request.delete(`/api/materials/${material.id}`);
  expect(await search(env, '赏荷')).toEqual({ titles: [], total: 0 });
});
