import { describe, expect, it } from 'vitest';
import { BLOCK_TARGET_MAX, BLOCK_TARGET_MIN, splitChapterBlocks } from '../src/chapterblocks/blocks';
import { FakeLLM } from '../src/llm/fake';
import { configureRoute, createTestApp, seedBook, seedChapterOutline, seedMaterial, seedVolume, type TestEnv } from './helpers';
import { PASS_TEXT, draftResult, semanticResult } from './text-fixtures';

function blockTexts(content: string): string[] {
  return splitChapterBlocks(content).map((block) => block.text);
}

describe('splitChapterBlocks 切块（纯函数）', () => {
  it('按空行切段；过短段并入相邻段；块长落在目标区间（超长单段除外）', () => {
    const short = '甲。';
    const medium = '一'.repeat(220);
    const anotherMedium = '二'.repeat(220);
    const blocks = blockTexts([short, medium, anotherMedium].join('\n\n'));
    // 过短段并入下一段，凑出一段 ≥ MIN 的块；两段 medium 各自成块
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(`${short}\n${medium}`);
    expect(blocks[1]).toBe(anotherMedium);
    for (const text of blocks.slice(0, -1)) {
      expect(text.length).toBeGreaterThanOrEqual(BLOCK_TARGET_MIN);
    }
  });

  it('超长单段独立成块（不在段内劈开）', () => {
    const huge = '三'.repeat(BLOCK_TARGET_MAX + 200);
    const blocks = blockTexts(`${huge}\n\n尾段。`);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(huge); // 原样保留，不截断
  });

  it('幂等：同正文恒得同块序列；chunk_index 连续编号；空正文得空数组', () => {
    const content = ['甲段。', '乙段。'.repeat(50), '丙段。'].join('\n\n');
    expect(splitChapterBlocks(content)).toEqual(splitChapterBlocks(content));
    expect(splitChapterBlocks(content).map((block) => block.index)).toEqual([0, 1, 2].slice(0, splitChapterBlocks(content).length));
    expect(splitChapterBlocks('')).toEqual([]);
    expect(splitChapterBlocks('\n\n  \n\n')).toEqual([]);
  });
});

/** 批准指定章纲并生成该章（路由由用例自行配置，避免供应商重名） */
async function commitChapter(request: TestEnv['request'], bookId: number, volumeId: number, idx: number) {
  const outline = await seedChapterOutline(request, bookId, volumeId, { title: `第${idx}章 测试` });
  await request.post(`/api/books/${bookId}/outlines/chapters/${outline.id}/status`, { status: 'approved' });
  const res = await request.post(`/api/books/${bookId}/chapters/${idx}/generate`, {});
  expect(res.status).toBe(200);
}

function blockRows(db: TestEnv['db'], bookId: number) {
  return db
    .prepare(
      `SELECT e.chunk_index, e.model, e.dim FROM doc_embeddings e
       JOIN chapters c ON c.id = e.entity_id
       WHERE e.entity_type = 'chapter_block' AND c.book_id = ?
       ORDER BY e.chunk_index`
    )
    .all(bookId) as { chunk_index: number; model: string; dim: number }[];
}

function materialRowCount(db: TestEnv['db']): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM doc_embeddings WHERE entity_type = 'material'`).get() as { count: number }).count;
}

describe('T19 正文块向量：回灌管道', () => {
  it('commit 后自动切块建向量：块数与 chunk_index 正确；路由停用静默缺席且提交照常', async () => {
    const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
    const { request, db } = createTestApp(llm);
    for (const task of ['draft', 'verify', 'embed'] as const) await configureRoute(request, task);
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    await commitChapter(request, book.id, volume.id, 1);

    // PASS_TEXT 无空行 → 恰一块；chunk_index 从 0 连续编号，模型取路由
    expect(splitChapterBlocks(PASS_TEXT)).toHaveLength(1);
    const rows = blockRows(db, book.id);
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.chunk_index)).toEqual([0]);
    expect(rows[0]!.model).toBe('embed-model');

    // 降级对照：停用 embed 路由后另一本书生成照常、无向量行（失败静默语义）
    await request.put('/api/settings/routes/embed', { enabled: false });
    const book2 = await seedBook(request, { title: '无路由之书' });
    const volume2 = await seedVolume(request, book2.id);
    await commitChapter(request, book2.id, volume2.id, 1);
    expect(blockRows(db, book2.id)).toHaveLength(0);
    expect((await request.get(`/api/books/${book2.id}/chapters/1`)).status).toBe(200);
  });

  it('人工编辑正文后该章向量重灌：块数随新稿变化', async () => {
    const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
    const { request, db } = createTestApp(llm);
    for (const task of ['draft', 'verify', 'embed'] as const) await configureRoute(request, task);
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    await commitChapter(request, book.id, volume.id, 1);
    expect(blockRows(db, book.id)).toHaveLength(1); // PASS_TEXT 单段一块

    // 新稿两个长段 → 两块（旧行被整章替换）
    const newContent = `${'四'.repeat(300)}\n\n${'五'.repeat(300)}`;
    const patch = await request.patch(`/api/books/${book.id}/chapters/1`, { content: newContent });
    expect(patch.status).toBe(200);
    const after = blockRows(db, book.id);
    expect(after.map((row) => row.chunk_index)).toEqual([0, 1]);
  });

  it('书级重建：409 / 补缺失 / 换模型 stale / 幂等空转', async () => {
    const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) }, embed: new Error('宕机') });
    const { request, db } = createTestApp(llm);
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);

    // 未配 embed 路由 → 409
    expect((await request.post(`/api/books/${book.id}/chapter-blocks/reindex`, {})).status).toBe(409);

    for (const task of ['draft', 'verify', 'embed'] as const) await configureRoute(request, task);
    await commitChapter(request, book.id, volume.id, 1); // 提交时嵌入失败 → 静默无行
    expect(blockRows(db, book.id)).toHaveLength(0);

    // 恢复嵌入 → 重建补齐
    llm.script.embed = undefined;
    const outcome = await request.post(`/api/books/${book.id}/chapter-blocks/reindex`, {});
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ model: 'embed-model', indexed: 1, failed: [] });
    expect(blockRows(db, book.id)).toHaveLength(1);

    // 换模型（重配路由）→ 旧行 stale → 重建归到新模型
    await request.put('/api/settings/routes/embed', { model: 'bge-m3' });
    const again = await request.post(`/api/books/${book.id}/chapter-blocks/reindex`, {});
    expect(again.body).toMatchObject({ model: 'bge-m3', indexed: 1 });
    expect(blockRows(db, book.id).every((row) => row.model === 'bge-m3')).toBe(true);

    // 已是最新时重建 → indexed 0（幂等空转）
    const idle = await request.post(`/api/books/${book.id}/chapter-blocks/reindex`, {});
    expect(idle.body).toMatchObject({ indexed: 0, failed: [] });
  });

  it('级联：删书清正文块向量；素材删除清素材向量（应用层级联回归）', async () => {
    const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
    const { request, db } = createTestApp(llm);
    for (const task of ['draft', 'verify', 'embed'] as const) await configureRoute(request, task);
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    await commitChapter(request, book.id, volume.id, 1);
    const material = await seedMaterial(request, { type: 'setting', title: '玄铁令', content: '玄天宗信物。' });
    expect(materialRowCount(db)).toBeGreaterThan(0);
    expect(blockRows(db, book.id).length).toBeGreaterThan(0);

    await request.delete(`/api/materials/${material.id}`);
    expect(materialRowCount(db)).toBe(0);

    await request.delete(`/api/books/${book.id}`);
    expect(blockRows(db, book.id)).toHaveLength(0);
  });
});
