import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import type { EchoSearchResponse } from '../src/chapterblocks/similarity';
import { configureRoute, createTestApp, seedBook, seedChapterOutline, seedVolume, type TestEnv } from './helpers';
import { PASS_TEXT, draftResult, semanticResult } from './text-fixtures';

/**
 * 三章异质正文：第 1/3 章含独特段 X（≥200 字自成一块），第 2 章完全无关。
 * PASS_TEXT 落稿保证过 verify 闸门，随后逐章 PATCH 换装（编辑路径重灌块向量、不重新过闸）。
 */
const X = '雨夜的灯笼在巷口摇晃，他握紧了那半块玄铁令，纹路在雨里泛着冷光。'.repeat(7);
const UNRELATED = '二'.repeat(300);
const chapterContent = (idx: number) => (idx === 2 ? UNRELATED : `${'一'.repeat(220)}\n\n${X}`);

async function setupEchoBook(llm: FakeLLM): Promise<{ request: TestEnv['request']; bookId: number }> {
  const { request } = createTestApp(llm);
  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  for (let idx = 1; idx <= 3; idx++) {
    const outline = await seedChapterOutline(request, book.id, volume.id, { title: `第${idx}章 测试` });
    await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, { status: 'approved' });
  }
  for (const task of ['draft', 'verify', 'embed'] as const) await configureRoute(request, task);
  llm.script.respond = { draft: draftResult(PASS_TEXT), verify: semanticResult([]) };
  for (let idx = 1; idx <= 3; idx++) {
    const res = await request.post(`/api/books/${book.id}/chapters/${idx}/generate`, {});
    if (res.status !== 200) console.log('GEN_FAIL', idx, res.status, JSON.stringify(res.body).slice(0, 300));
    expect(res.status).toBe(200);
    const patch = await request.patch(`/api/books/${book.id}/chapters/${idx}`, { content: chapterContent(idx) });
    if (patch.status !== 200) console.log('PATCH_FAIL', idx, patch.status, JSON.stringify(patch.body).slice(0, 300));
    expect(patch.status).toBe(200);
  }
  return { request, bookId: book.id };
}

async function echoSearch(
  request: TestEnv['request'],
  bookId: number,
  body: Record<string, unknown>
): Promise<{ status: number; body: EchoSearchResponse & { error?: string } }> {
  const res = await request.post(`/api/books/${bookId}/chapter-blocks/search`, body);
  expect([200, 409, 400, 502]).toContain(res.status);
  return { status: res.status, body: res.body };
}

describe('T21 呼应检索', () => {
  it('查询句命中各章的 X 段（相似度 1）排首；excludeIdx 排除当前章自身', async () => {
    const { request, bookId } = await setupEchoBook(new FakeLLM());

    // 在第 1 章视角检索 X 片段：自身（第 1 章）被排除，第 3 章的 X 排第一
    const res = await echoSearch(request, bookId, { query: X.slice(0, 60), excludeIdx: 1 });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('embed-model');
    expect(res.body.items[0]).toMatchObject({ idx: 3, chunk: 1 });
    expect(res.body.items[0]!.similarity).toBeGreaterThan(0.98); // 查询向量未量化，落库向量经 Float32 量化 → 恰 1 有微差
    expect(res.body.items[0]!.excerpt).toBe(X.slice(0, 40));
    expect(res.body.items.every((item) => item.idx !== 1)).toBe(true);

    // 不排除时三块相关块全在（第 1/3 章的 X 与填充段块），X 块按相似度居首
    const all = await echoSearch(request, bookId, { query: X.slice(0, 60) });
    expect(all.status).toBe(200);
    expect(all.body.items[0]!.similarity).toBeGreaterThan(0.98);
    expect(all.body.items.filter((item) => item.similarity > 0.9)).toHaveLength(2);
  });

  it('topK 可配；query 校验（空白 400）', async () => {
    const { request, bookId } = await setupEchoBook(new FakeLLM());

    const limited = await echoSearch(request, bookId, { query: '玄铁令', topK: 1 });
    expect(limited.status).toBe(200);
    expect(limited.body.items).toHaveLength(1);

    expect((await echoSearch(request, bookId, { query: '   ' })).status).toBe(400);
    expect((await echoSearch(request, bookId, {})).status).toBe(400);
  });

  it('无 embed 路由 409；有路由但无向量空列表', async () => {
    const { request } = createTestApp();
    const book = await seedBook(request);
    expect((await echoSearch(request, book.id, { query: '任意' })).status).toBe(409);
    expect((await echoSearch(request, book.id, { query: '任意' })).body.error).toContain('embed');

    const configured = new FakeLLM();
    const { request: request2, bookId } = await setupEchoBook(configured);
    // 空书（无章节 → 无向量）→ items 空
    const empty = await seedBook(request2, { title: '空书' });
    const res = await echoSearch(request2, empty.id, { query: '任意' });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
