import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import type { SimilarityReport } from '../src/chapterblocks/similarity';
import { configureRoute, createTestApp, seedBook, seedChapterOutline, seedVolume, type TestEnv } from './helpers';
import { PASS_TEXT, draftResult, semanticResult } from './text-fixtures';

/**
 * 自定义章内容（块向量经编辑路径重灌，编辑不重新过 verify 闸门，故无需迁就 8 维检测）：
 * - 填充段：各章互斥的单字重复段（2-gram 与彼此及桥段零共享，互似度恒 0）
 * - 桥段：三章同一文本 → 相似度恰 1.0 的「重复桥段」
 */
const BRIDGE = '雨夜的灯笼在巷口摇晃，他握紧了那半块玄铁令，纹路在雨里泛着冷光。'.repeat(7);
const FILLER_CHARS = ['一', '二', '三'] as const;
const fillerOf = (idx: number) => FILLER_CHARS[(idx - 1) % FILLER_CHARS.length]!.repeat(220);
const chapterContent = (idx: number) => `${fillerOf(idx)}\n\n${BRIDGE}`;

/** 落稿三章（PASS_TEXT 保证过闸）后逐章编辑为自定义内容（触发块向量重灌） */
async function setupThreeChapters(): Promise<{ request: TestEnv['request']; bookId: number }> {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
  const { request } = createTestApp(llm);
  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  for (let idx = 1; idx <= 3; idx++) {
    const outline = await seedChapterOutline(request, book.id, volume.id, { title: `第${idx}章 测试` });
    await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, { status: 'approved' });
  }
  for (const task of ['draft', 'verify', 'embed'] as const) await configureRoute(request, task);
  for (let idx = 1; idx <= 3; idx++) {
    const res = await request.post(`/api/books/${book.id}/chapters/${idx}/generate`, {});
    expect(res.status).toBe(200);
    const patch = await request.patch(`/api/books/${book.id}/chapters/${idx}`, { content: chapterContent(idx) });
    expect(patch.status).toBe(200);
  }
  return { request, bookId: book.id };
}

async function similarityOf(request: TestEnv['request'], bookId: number): Promise<SimilarityReport> {
  const res = await request.get(`/api/books/${bookId}/similarity`);
  expect(res.status).toBe(200);
  return res.body as SimilarityReport;
}

describe('T20 跨章情节自相似', () => {
  it('重复桥段跨章报出；相邻章窗口排除；窗口与阈值可配', async () => {
    const { request, bookId } = await setupThreeChapters();

    // 默认窗口 5：三对全是近章（Δ=1,1,2）→ 全部排除
    const near = await similarityOf(request, bookId);
    expect(near.model).toBe('embed-model');
    expect(near.scannedChapters).toBe(3);
    expect(near.scannedBlocks).toBe(6); // 每章两块（填充段 + 桥段）
    expect(near.items).toEqual([]);

    // 窗口调到 2：只报 (1,3)
    await request.put('/api/settings/pipeline', { similarityExcludeWindow: 2 });
    const mid = await similarityOf(request, bookId);
    expect(mid.items).toHaveLength(1);
    expect(mid.items[0]).toMatchObject({ aIdx: 1, aChunk: 1, bIdx: 3, bChunk: 1 });
    expect(mid.items[0]!.similarity).toBeCloseTo(1, 5); // 同文本 → 同伪向量 → 点积 1
    expect(mid.items[0]!.aExcerpt).toBe(BRIDGE.slice(0, 40));

    // 窗口 0：三对全报，相似度同分按章号升序稳定排序
    await request.put('/api/settings/pipeline', { similarityExcludeWindow: 0 });
    const all = await similarityOf(request, bookId);
    expect(all.items.map((pair) => [pair.aIdx, pair.bIdx])).toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
    ]);

    // 阈值 0：零相似对也进榜（6 块全组合 15 对）；回调 0.85 → 只剩同文本对
    await request.put('/api/settings/pipeline', { similarityThreshold: 0 });
    const loose = await similarityOf(request, bookId);
    expect(loose.items).toHaveLength(15);
    await request.put('/api/settings/pipeline', { similarityThreshold: 0.85 });
    expect((await similarityOf(request, bookId)).items).toHaveLength(3);
  });

  it('top-K 可配：候选超限时按相似度降序截断', async () => {
    const { request, bookId } = await setupThreeChapters();
    await request.put('/api/settings/pipeline', { similarityExcludeWindow: 0, similarityTopK: 2 });

    const report = await similarityOf(request, bookId);
    expect(report.items).toHaveLength(2);
    // 截断保留的是相似度最高的（同文本对 sim=1 优先于零相似对）
    for (const pair of report.items) expect(pair.similarity).toBeCloseTo(1, 5);
  });

  it('无向量（无路由）空态：model null、扫描计数 0', async () => {
    const { request } = createTestApp();
    const book = await seedBook(request);
    const report = await similarityOf(request, book.id);
    expect(report).toEqual({ items: [], scannedChapters: 0, scannedBlocks: 0, model: null });
  });
});
