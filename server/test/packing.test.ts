import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET_TOKENS } from '../src/packing/pack';
import {
  createTestApp,
  seedBook,
  seedCharacterState,
  seedChapterOutline,
  seedMaterial,
  seedBookMaterial,
  seedVolume,
  type TestEnv,
} from './helpers';

/** 装填指定章的注入视图（budget 缺省走服务端默认预算） */
async function pack(request: TestEnv['request'], bookId: number, chapter: number, budget?: number) {
  const query = `chapter=${chapter}${budget === undefined ? '' : `&budget=${budget}`}`;
  return request.get(`/api/books/${bookId}/packing?${query}`);
}

/** 按层 key 取层 */
function layerOf(view: { layers: PackingLayer[] }, key: string): PackingLayer {
  const layer = view.layers.find((candidate) => candidate.key === key);
  if (!layer) throw new Error(`缺少 ${key} 层`);
  return layer;
}

type PackingLayer = import('../src/packing/pack').PackingLayer;
type InjectionView = import('../src/packing/pack').InjectionView;

/** 场景 A 的预置：两卷一章纲、三个角色状态、两条可命中章纲关键词的书内素材 */
async function seedLayeredScene(request: TestEnv['request']) {
  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  await seedChapterOutline(request, book.id, volume.id); // 第1章（默认内容）
  await seedChapterOutline(request, book.id, volume.id, {
    title: '第2章 残玉低语',
    summary: '陆沉舟参悟残玉中的神秘功法，初窥门径。',
  });
  await seedCharacterState(request, book.id, { name: '陆沉舟', chapter: 1, category: 'injury' });
  await seedCharacterState(request, book.id, {
    name: '苏晚',
    chapter: 1,
    content: '右手腕缠着绷带，隐藏了烫伤。',
    evidence: '「你的手怎么了？」「没事，烫的。」',
  });
  await seedCharacterState(request, book.id, { name: '陆沉舟', chapter: 2, category: 'secret' });
  const m2 = await seedMaterial(request, {
    type: 'setting',
    title: '残玉设定',
    content: '残玉内藏神秘功法传承，贴身发烫。',
    source: { kind: 'reference', book: '参考书甲', chapter: '第2章' },
  });
  const m1 = await seedMaterial(request, {
    type: 'trope',
    title: '觉醒桥段',
    content: '主角参悟神秘功法，当夜突破，废柴逆袭。',
    source: { kind: 'reference', book: '参考书甲', chapter: '第5章' },
  });
  await seedBookMaterial(request, book.id, m2.id);
  await seedBookMaterial(request, book.id, m1.id);
  return { book, volume, m1, m2 };
}

describe('T9 注入视图：分层装填', () => {
  it('为章生成注入视图：四层结构、内容与 token 数齐备', async () => {
    const { request } = createTestApp();
    const { book, volume, m1, m2 } = await seedLayeredScene(request);

    const res = await pack(request, book.id, 2);
    expect(res.status).toBe(200);
    const view = res.body as InjectionView;

    // 顶层账目
    expect(view.bookId).toBe(book.id);
    expect(view.chapter).toBe(2);
    expect(view.budgetTokens).toBe(DEFAULT_BUDGET_TOKENS);
    expect(view.usedTokens).toBeGreaterThan(0);
    expect(view.overBudget).toBe(false);

    // 四层齐备且顺序固定：必带层在前，相关性层最后
    expect(view.layers.map((layer) => layer.key)).toEqual(['contract', 'outline', 'characters', 'relevance']);
    expect(view.layers.map((layer) => layer.kind)).toEqual(['must', 'must', 'must', 'relevance']);
    // 每层 token 数等于其条目之和；全局 usedTokens 等于各层之和
    for (const layer of view.layers) {
      expect(layer.tokens).toBe(layer.items.reduce((sum, item) => sum + item.tokens, 0));
      for (const item of layer.items) expect(item.tokens).toBeGreaterThan(0);
    }
    expect(view.usedTokens).toBe(view.layers.reduce((sum, layer) => sum + layer.tokens, 0));

    // 书契约层
    const contract = layerOf(view, 'contract');
    expect(contract.items).toHaveLength(1);
    expect(contract.items[0]!.refType).toBe('book-contract');
    expect(contract.items[0]!.title).toBe(book.title);
    expect(contract.items[0]!.text).toContain('东方玄幻');
    expect(contract.items[0]!.text).toContain('热血爽文');
    expect(contract.items[0]!.text).toContain('伏笔必回收');

    // 大纲层：所属卷纲 + 该章章纲（第 2 条章纲）
    const outline = layerOf(view, 'outline');
    expect(outline.items.map((item) => item.refType)).toEqual(['volume-outline', 'chapter-outline']);
    expect(outline.items[0]!.title).toBe(volume.title);
    expect(outline.items[1]!.title).toBe('第2章 残玉低语');
    expect(outline.items[1]!.text).toContain('参悟残玉');

    // 角色运行时层：第 2 章前的全部最新状态，按章号升序
    const characters = layerOf(view, 'characters');
    expect(characters.items.map((item) => item.sourceChapter)).toEqual([1, 1, 2]);
    expect(characters.items[0]!.title).toContain('陆沉舟');
    expect(characters.items[1]!.title).toContain('苏晚');

    // 相关性层：书内引用素材按出处章号升序注入（ADR-0002）
    const relevance = layerOf(view, 'relevance');
    expect(relevance.items.map((item) => item.refId)).toEqual([m2.id, m1.id]);
    expect(relevance.items.map((item) => item.sourceChapter)).toEqual([2, 5]);
    expect(relevance.items[0]!.text).toContain('残玉内藏神秘功法传承');
    expect(relevance.truncated).toBe(false);
    expect(relevance.droppedCount).toBe(0);
  });

  it('相关性层只含书内引用素材，并应用书内覆写后的生效内容', async () => {
    const { request } = createTestApp();
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    await seedChapterOutline(request, book.id, volume.id, {
      title: '第1章 玄铁令',
      summary: '陆沉舟在铁匠铺发现玄铁令的秘密。',
    });
    const referenced = await seedMaterial(request, {
      type: 'setting',
      title: '玄铁令',
      content: '玄铁令是玄天宗信物，可号令外门弟子。',
      source: { kind: 'reference', book: '参考书甲', chapter: '第3章' },
    });
    const unreferenced = await seedMaterial(request, {
      type: 'setting',
      title: '玄铁令·别书考',
      content: '玄铁令在别书中的形态考据。',
      source: { kind: 'reference', book: '参考书乙', chapter: '第8章' },
    });
    await seedBookMaterial(request, book.id, referenced.id);

    // 书内覆写：内容改写为本书版本（全局库不受影响）
    const patchRes = await request.patch(`/api/books/${book.id}/materials/${referenced.id}`, {
      overrides: { content: '玄铁令在本书记作玄钥，为女主信物。' },
    });
    expect(patchRes.status).toBe(200);

    const res = await pack(request, book.id, 1);
    expect(res.status).toBe(200);
    const relevance = layerOf(res.body as InjectionView, 'relevance');

    // 只装书内引用的那条，且注入文本用覆写后的生效内容
    expect(relevance.items).toHaveLength(1);
    expect(relevance.items[0]!.refId).toBe(referenced.id);
    expect(relevance.items[0]!.text).toContain('玄钥');
    expect(relevance.items[0]!.text).not.toContain('号令外门弟子');
    expect(relevance.items.map((item) => item.refId)).not.toContain(unreferenced.id);
  });

  it('无引用素材或查询无命中时相关性层为空（不误报截断）', async () => {
    const { request } = createTestApp();
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    await seedChapterOutline(request, book.id, volume.id, {
      title: '第1章 孤章',
      summary: '完全独立的剧情，没有可引用素材。',
    });
    // 引进了素材但内容与章纲毫无交集
    const m = await seedMaterial(request, {
      type: 'style',
      title: '雪原行军',
      content: '风雪掠过旷野，他勒住缰绳，呼吸在寒气里凝成白霜。',
    });
    await seedBookMaterial(request, book.id, m.id);

    const res = await pack(request, book.id, 1);
    expect(res.status).toBe(200);
    const view = res.body as InjectionView;
    const relevance = layerOf(view, 'relevance');
    expect(relevance.items).toEqual([]);
    expect(relevance.truncated).toBe(false);
    expect(relevance.droppedCount).toBe(0);
    const mustTokens = view.layers.filter((layer) => layer.kind === 'must').reduce((sum, layer) => sum + layer.tokens, 0);
    expect(view.usedTokens).toBe(mustTokens);
  });
});

describe('T9 注入视图：预算截断', () => {
  it('调小预算：必带层原样保留，只截断相关性层；预算填满即停', async () => {
    const { request } = createTestApp();
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    await seedChapterOutline(request, book.id, volume.id, {
      title: '第1章 焚天诀',
      summary: '陆沉舟修炼焚天诀，境界暴涨。',
    });
    // 高相关长素材：查询词高频出现（BM25 排前），内容较长（先撑爆预算）。
    // 两条素材都只命中查询里唯一的实词「焚天诀」，其余字段避开章纲/卷纲词汇——单词命中时
    // BM25 名次只由词频决定，断言才可预测
    const huge = await seedMaterial(request, {
      type: 'trope',
      title: '焚天诀总纲',
      content: '焚天诀焚天诀焚天诀焚天诀焚天诀焚天诀焚天诀焚天诀，以火入道，纯阳一脉，讲究火候吞吐，周天运转，收发由心。',
      payload: { structure: '起承转合' },
      source: { kind: 'reference', book: '参考书甲', chapter: '第9章' },
    });
    const tiny = await seedMaterial(request, {
      type: 'setting',
      title: '焚天诀残篇',
      content: '焚天诀，缺第一重。',
      payload: { category: '功法残卷' },
      source: { kind: 'reference', book: '参考书甲', chapter: '第4章' },
    });
    await seedBookMaterial(request, book.id, huge.id);
    await seedBookMaterial(request, book.id, tiny.id);

    const fullRes = await pack(request, book.id, 1, 1_000_000);
    expect(fullRes.status).toBe(200);
    const full = fullRes.body as InjectionView;
    const fullRelevance = layerOf(full, 'relevance');
    expect(fullRelevance.items).toHaveLength(2);
    // 选材名次按相关度：查询词高频者第一（此时与章节号顺序相反，为重排测试埋点）
    const rankById = new Map(fullRelevance.items.map((item) => [item.refId, item.rank]));
    expect(rankById.get(huge.id)).toBe(1);
    expect(rankById.get(tiny.id)).toBe(2);
    // 注入顺序按章节号重排：第4章在前，第9章在后（ADR-0002）
    expect(fullRelevance.items.map((item) => item.sourceChapter)).toEqual([4, 9]);

    const mustTokens = full.layers.filter((layer) => layer.kind === 'must').reduce((sum, layer) => sum + layer.tokens, 0);
    const tokensOf = (id: number) => fullRelevance.items.find((item) => item.refId === id)!.tokens;
    const mustSnapshot = full.layers
      .filter((layer) => layer.kind === 'must')
      .map((layer) => ({ key: layer.key, tokens: layer.tokens, count: layer.items.length }));

    // 预算恰好容下必带层 + 相关度第一名：只装第一名（哪怕它章节号更大），第二名截断
    const fitRes = await pack(request, book.id, 1, mustTokens + tokensOf(huge.id));
    expect(fitRes.status).toBe(200);
    const fit = fitRes.body as InjectionView;
    const fitRelevance = layerOf(fit, 'relevance');
    expect(fitRelevance.items.map((item) => item.refId)).toEqual([huge.id]);
    expect(fitRelevance.truncated).toBe(true);
    expect(fitRelevance.droppedCount).toBe(1);
    expect(fit.usedTokens).toBe(mustTokens + tokensOf(huge.id));
    expect(fit.overBudget).toBe(false);

    // 预算再调小到只够必带层：相关性层清空；必带层原样保留
    const tightRes = await pack(request, book.id, 1, mustTokens);
    expect(tightRes.status).toBe(200);
    const tight = tightRes.body as InjectionView;
    expect(layerOf(tight, 'relevance').items).toEqual([]);
    expect(layerOf(tight, 'relevance').droppedCount).toBe(2);
    expect(layerOf(tight, 'relevance').truncated).toBe(true);
    for (const snapshot of mustSnapshot) {
      const layer = layerOf(tight, snapshot.key);
      expect(layer.tokens).toBe(snapshot.tokens);
      expect(layer.items).toHaveLength(snapshot.count);
    }
    expect(tight.overBudget).toBe(false);

    // 预算为 1：必带层依然永不丢失（overBudget 标记超额）
    const tinyBudgetRes = await pack(request, book.id, 1, 1);
    expect(tinyBudgetRes.status).toBe(200);
    const tinyBudget = tinyBudgetRes.body as InjectionView;
    for (const snapshot of mustSnapshot) {
      const layer = layerOf(tinyBudget, snapshot.key);
      expect(layer.tokens).toBe(snapshot.tokens);
      expect(layer.items).toHaveLength(snapshot.count);
    }
    expect(tinyBudget.overBudget).toBe(true);
    expect(layerOf(tinyBudget, 'relevance').items).toEqual([]);
  });
});

describe('T9 注入视图：章节号重排（ADR-0002）', () => {
  it('检索结果一律按出处章节号升序注入，无法解析章节号的排最后', async () => {
    const { request } = createTestApp();
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    await seedChapterOutline(request, book.id, volume.id, {
      title: '第1章 玄铁剑',
      summary: '陆沉舟在剑庐重铸玄铁剑。',
    });
    const chapterOf = { high: '第9章', mid: '第4章', numeric: '3', unparsed: '卷外·散佚' };
    // 四条素材都只命中章纲里唯一的实词「玄铁剑」（词频 9/2/1/1），其余字段避开章纲/卷纲词汇，
    // 保证 BM25 名次可预测：高频者第一；结构化字段显式给出，避开默认值里的碰撞词
    const mHigh = await seedMaterial(request, {
      type: 'trope',
      title: '玄铁剑重铸',
      content: '玄铁剑玄铁剑玄铁剑玄铁剑玄铁剑玄铁剑玄铁剑玄铁剑，断锋淬火，重新开锋。',
      payload: { structure: '仪式感铺垫' },
      source: { kind: 'reference', book: '参考书甲', chapter: chapterOf.high },
    });
    const mMid = await seedMaterial(request, {
      type: 'setting',
      title: '玄铁剑来历',
      content: '玄铁剑，天外陨铁所锻。',
      payload: { category: '神兵' },
      source: { kind: 'reference', book: '参考书甲', chapter: chapterOf.mid },
    });
    const mNumeric = await seedMaterial(request, {
      type: 'style',
      title: '出鞘描写',
      content: '玄铁剑出鞘时的描写节奏。',
      payload: { rhythm: '长句铺陈' },
      source: { kind: 'reference', book: '参考书甲', chapter: chapterOf.numeric },
    });
    const mUnparsed = await seedMaterial(request, {
      type: 'skeleton',
      title: '散佚篇骨骼',
      content: '玄铁剑相关篇章的结构参考。',
      payload: { pacingCurve: '节奏放缓', volumeStructure: '卷终决战', archetypes: '沉默铁匠' },
      source: { kind: 'reference', book: '参考书甲', chapter: chapterOf.unparsed },
    });
    for (const m of [mHigh, mMid, mNumeric, mUnparsed]) await seedBookMaterial(request, book.id, m.id);

    const res = await pack(request, book.id, 1, 1_000_000);
    expect(res.status).toBe(200);
    const relevance = layerOf(res.body as InjectionView, 'relevance');
    expect(relevance.items).toHaveLength(4);
    // 相关度名次：高频者第一
    expect(relevance.items.find((item) => item.refId === mHigh.id)!.rank).toBe(1);
    // 注入顺序与相关度无关：章节号 3 → 4 → 9，解析不了的「卷外·散佚」殿后
    expect(relevance.items.map((item) => item.refId)).toEqual([mNumeric.id, mMid.id, mHigh.id, mUnparsed.id]);
    expect(relevance.items.map((item) => item.sourceChapter)).toEqual([3, 4, 9, null]);
  });
});

describe('T9 注入视图：角色运行时增量语义', () => {
  it('取各角色各类目在目标章前的最新状态，未来章不泄漏，旧状态被新状态取代', async () => {
    const { request } = createTestApp();
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    for (let n = 1; n <= 4; n++) {
      await seedChapterOutline(request, book.id, volume.id, { title: `第${n}章`, summary: `第${n}章剧情。` });
    }
    await seedCharacterState(request, book.id, { name: '陆沉舟', chapter: 1, category: 'injury', content: '左臂旧伤未愈。' });
    await seedCharacterState(request, book.id, {
      name: '陆沉舟',
      chapter: 3,
      category: 'injury',
      content: '伤势痊愈，经脉重塑。',
      evidence: '「三个月之期未到，你的手臂却已痊愈？」',
    });
    await seedCharacterState(request, book.id, { name: '陆沉舟', chapter: 2, category: 'secret', content: '身怀残玉秘密。' });
    await seedCharacterState(request, book.id, { name: '苏晚', chapter: 4, category: 'injury', content: '苏晚在第4章受伤。' });

    // 第 3 章视角：伤势取第 3 章最新值；秘密取第 2 章；苏晚的第 4 章状态不泄漏
    const res3 = await pack(request, book.id, 3);
    expect(res3.status).toBe(200);
    const chars3 = layerOf(res3.body as InjectionView, 'characters').items;
    expect(chars3).toHaveLength(2);
    const injury3 = chars3.find((item) => item.title.includes('伤势'))!;
    expect(injury3.sourceChapter).toBe(3);
    expect(injury3.text).toContain('伤势痊愈');
    expect(injury3.text).not.toContain('旧伤');
    expect(chars3.some((item) => item.title.includes('苏晚'))).toBe(false);

    // 第 2 章视角：伤势仍是第 1 章旧值
    const res2 = await pack(request, book.id, 2);
    const chars2 = layerOf(res2.body as InjectionView, 'characters').items;
    const injury2 = chars2.find((item) => item.title.includes('伤势'))!;
    expect(injury2.sourceChapter).toBe(1);
    expect(injury2.text).toContain('旧伤');

    // 第 4 章视角：苏晚入场
    const res4 = await pack(request, book.id, 4);
    const chars4 = layerOf(res4.body as InjectionView, 'characters').items;
    expect(chars4.some((item) => item.title.includes('苏晚'))).toBe(true);
  });
});

describe('T9 注入视图：参数校验', () => {
  it('章号超出章纲范围 / 书无章纲 / 非法章号或预算 / 书不存在 → 400/404', async () => {
    const { request } = createTestApp();
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    await seedChapterOutline(request, book.id, volume.id);
    await seedChapterOutline(request, book.id, volume.id);

    const outOfRange = await pack(request, book.id, 3);
    expect(outOfRange.status).toBe(400);
    expect(outOfRange.body.error).toContain('超出章纲范围');

    const emptyBook = await seedBook(request, { title: '无纲之书' });
    const noOutline = await pack(request, emptyBook.id, 1);
    expect(noOutline.status).toBe(400);
    expect(noOutline.body.error).toContain('章纲');

    expect((await pack(request, book.id, 0)).status).toBe(400);
    expect((await pack(request, book.id, -1)).status).toBe(400);
    expect((await request.get(`/api/books/${book.id}/packing?chapter=abc`)).status).toBe(400);
    expect((await request.get(`/api/books/${book.id}/packing`)).status).toBe(400);
    expect((await pack(request, book.id, 1, 0)).status).toBe(400);
    expect((await request.get(`/api/books/${book.id}/packing?chapter=1&budget=abc`)).status).toBe(400);
    expect((await pack(request, 999, 1)).status).toBe(404);
  });
});
