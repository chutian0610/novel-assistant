import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import { configureRoute, createTestApp, seedBook, seedChapterOutline, seedMaterial, seedBookMaterial, seedVolume, type TestEnv } from './helpers';

type InjectionView = import('../src/packing/pack').InjectionView;
type PackingLayer = import('../src/packing/pack').PackingLayer;

async function pack(request: TestEnv['request'], bookId: number, chapter = 1) {
  const res = await request.get(`/api/books/${bookId}/packing?chapter=${chapter}`);
  expect(res.status).toBe(200);
  return res.body as InjectionView;
}

function relevanceOf(view: InjectionView): PackingLayer {
  const layer = view.layers.find((candidate) => candidate.key === 'relevance');
  if (!layer) throw new Error('缺少 relevance 层');
  return layer;
}

/**
 * 「意近词异」夹具：章纲查询含「突破/境界」，素材甲正面命中（BM25 词频 + 向量双高），
 * 素材乙的分词（破/境/之/威…）与查询 token 零交集——BM25 召不回，但字符 2-gram「破境」
 * 与查询共享，伪向量方向相近（向量路召回）。素材丙与查询字面无关，仅以极弱向量相似度
 * 殿后（真实嵌入模型对无关文本同样给非零余弦，弱相似靠 RRF 权重衰减 + 预算截断沉底）。
 */
async function seedRecallScene(request: TestEnv['request'], bookId: number) {
  const volume = await seedVolume(request, bookId, { title: '第一卷 宗门风云', summary: '宗门大比风云。' });
  await seedChapterOutline(request, bookId, volume.id, {
    title: '第1章 试炼',
    summary: '主角突破境界，一战成名。',
  });
  const mDouble = await seedMaterial(request, {
    type: 'setting',
    title: '突破境界面面观',
    content: '突破突破突破突破突破突破突破突破突破，境界再攀。',
    payload: { category: '功法' },
    source: { kind: 'reference', book: '参考书甲', chapter: '第3章' },
  });
  const mVecOnly = await seedMaterial(request, {
    type: 'setting',
    title: '破境余威',
    content: '破境之威震慑全场。',
    payload: { category: '功法' },
    source: { kind: 'reference', book: '参考书甲', chapter: '第5章' },
  });
  const mNone = await seedMaterial(request, {
    type: 'setting',
    title: '风雪旷野',
    content: '风雪掠过旷野。',
    payload: { category: '景物' },
    source: { kind: 'reference', book: '参考书甲', chapter: '第9章' },
  });
  for (const m of [mDouble, mVecOnly, mNone]) await seedBookMaterial(request, bookId, m.id);
  return { mDouble, mVecOnly, mNone };
}

describe('T17 RRF 混合装填', () => {
  it('意近词异素材经向量路召回，条目带 BM25/向量单路名次与融合名次', async () => {
    const llm = new FakeLLM();
    const { request } = createTestApp(llm);
    const book = await seedBook(request);
    await configureRoute(request, 'embed'); // 先配路由，素材写入即建向量
    const { mDouble, mVecOnly, mNone } = await seedRecallScene(request, book.id);

    const relevance = relevanceOf(await pack(request, book.id));

    // 融合名次：甲双路第一（1/61+1/61），乙仅向量路第二（1/62），丙弱相似殿后（1/63）
    expect(relevance.items.map((item) => item.rank)).toEqual([1, 2, 3]);
    expect(relevance.items[0]!.bm25Rank).toBe(1);
    expect(relevance.items[0]!.vectorRank).toBe(1);
    // 意近词异：BM25 召不回，向量路召回并携带单路名次
    expect(relevance.items[1]!.bm25Rank).toBeUndefined();
    expect(relevance.items[1]!.vectorRank).toBe(2);
    // 弱相似素材不缺席：仅向量路名次殿后（预算紧张时最先被截断）
    expect(relevance.items[2]!.bm25Rank).toBeUndefined();
    expect(relevance.items[2]!.vectorRank).toBe(3);
    // 注入顺序仍按出处章号升序（3 → 5 → 9，ADR-0002 与融合名次无关）
    expect(relevance.items.map((item) => item.refId)).toEqual([mDouble.id, mVecOnly.id, mNone.id]);
  });

  it('注入顺序仍按出处章号升序重排（ADR-0002，混合装填下不变）', async () => {
    const { request } = createTestApp(new FakeLLM());
    const book = await seedBook(request);
    await configureRoute(request, 'embed');
    const { mDouble, mVecOnly, mNone } = await seedRecallScene(request, book.id);
    // 素材甲出处章号改大到第 9 章（乙第 5 章、丙第 9 章）：融合名次甲第一，注入顺序乙最先
    const updated = await request.patch(`/api/materials/${mDouble.id}`, {
      source: { kind: 'reference', book: '参考书甲', chapter: '第9章' },
    });
    expect(updated.status).toBe(200);

    const relevance = relevanceOf(await pack(request, book.id));
    // 章号 5 → 9 → 9；同章号内按融合名次（甲 r1 在丙 r3 前）
    expect(relevance.items.map((item) => item.refId)).toEqual([mVecOnly.id, mDouble.id, mNone.id]);
    expect(relevance.items.map((item) => item.rank)).toEqual([2, 1, 3]);
  });

  it('降级零回归：未配置 embed 路由时行为与 V1 一致（纯 BM25、无单路标注）', async () => {
    const { request } = createTestApp(new FakeLLM());
    const book = await seedBook(request);
    const { mDouble, mVecOnly, mNone } = await seedRecallScene(request, book.id);

    const relevance = relevanceOf(await pack(request, book.id));
    // 只有词面命中的素材甲被召回；乙、丙（向量路专属）缺席
    expect(relevance.items.map((item) => item.refId)).toEqual([mDouble.id]);
    expect(relevance.items[0]!.rank).toBe(1);
    expect(relevance.items[0]!.bm25Rank).toBeUndefined();
    expect(relevance.items[0]!.vectorRank).toBeUndefined();
    expect(relevance.items.map((item) => item.refId)).not.toContain(mVecOnly.id);
    expect(relevance.items.map((item) => item.refId)).not.toContain(mNone.id);
  });

  it('查询嵌入失败自动降级纯 BM25：装填不因增强路失败而失败', async () => {
    const llm = new FakeLLM();
    const { request } = createTestApp(llm);
    const book = await seedBook(request);
    await configureRoute(request, 'embed');
    const { mDouble, mVecOnly } = await seedRecallScene(request, book.id);

    // 素材向量已在写入时建好；查询嵌入此刻开始失败
    llm.script.embed = new Error('查询嵌入服务宕机');
    const relevance = relevanceOf(await pack(request, book.id));

    expect(relevance.items.map((item) => item.refId)).toEqual([mDouble.id]);
    expect(relevance.items[0]!.rank).toBe(1);
    expect(relevance.items[0]!.bm25Rank).toBeUndefined();
    expect(relevance.items[0]!.vectorRank).toBeUndefined();
    expect(relevance.items.map((item) => item.refId)).not.toContain(mVecOnly.id);
  });

  it('embed 路由可用但素材从未建向量（配置晚于建库）：向量路为空，纯 BM25 兜底', async () => {
    const llm = new FakeLLM();
    const { request } = createTestApp(llm);
    const book = await seedBook(request);
    // 先建素材（无路由 → 写路径跳过索引），后配路由
    const { mDouble, mVecOnly } = await seedRecallScene(request, book.id);
    await configureRoute(request, 'embed');

    const relevance = relevanceOf(await pack(request, book.id));
    expect(relevance.items.map((item) => item.refId)).toEqual([mDouble.id]);
    expect(relevance.items[0]!.bm25Rank).toBeUndefined();
    expect(relevance.items[0]!.vectorRank).toBeUndefined();
    expect(relevance.items.map((item) => item.refId)).not.toContain(mVecOnly.id);
    // 此场景正是「重建向量索引」入口的用武之地：重索引后乙被向量路召回
    const reindexed = await request.post('/api/materials/embeddings/reindex', {});
    expect(reindexed.status).toBe(200);
    expect(reindexed.body.indexed).toBe(3);

    const after = relevanceOf(await pack(request, book.id));
    // 重索引后乙被向量路召回；丙以弱相似殿后
    expect(after.items.map((item) => item.rank)).toEqual([1, 2, 3]);
    expect(after.items[1]!.refId).toBe(mVecOnly.id);
    expect(after.items[1]!.vectorRank).toBe(2);
  });
});
