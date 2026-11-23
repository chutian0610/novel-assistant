import { expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import { draftResult, PASS_TEXT, semanticResult } from './text-fixtures';
import { configureRoute, createTestApp, seedBook, seedChapterOutline, seedVolume } from './helpers';

/** 预置两卷三章并全部生成（三章同用达标正文，标题各不相同） */
async function seedExportBook(llm: FakeLLM) {
  const env = createTestApp(llm);
  const { request } = env;
  const book = await seedBook(request);
  const volume1 = await seedVolume(request, book.id, { title: '第一卷·宗门试炼' });
  const volume2 = await seedVolume(request, book.id, { title: '第二卷·外出游历' });
  const outlines: { id: number }[] = [];
  for (const [volume, title] of [
    [volume1, '第1章 测灵'],
    [volume1, '第2章 觉醒'],
    [volume2, '第3章 下山'],
  ] as const) {
    const outline = await seedChapterOutline(request, book.id, volume.id, { title });
    outlines.push(outline);
    await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, { status: 'approved' });
  }
  for (const task of ['draft', 'verify'] as const) {
    await configureRoute(request, task);
  }
  for (let idx = 1; idx <= 3; idx++) {
    const res = await request.post(`/api/books/${book.id}/chapters/${idx}/generate`, {});
    if (res.status !== 200) throw new Error(`生成第 ${idx} 章失败：${res.status} ${JSON.stringify(res.body)}`);
  }
  return { env, bookId: book.id, volume1, volume2 };
}

it('全书导出 txt：章节完整、顺序正确、带书名头', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
  const { env, bookId } = await seedExportBook(llm);

  const res = await env.request.get(`/api/books/${bookId}/export?format=txt`);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('text/plain');
  const expected =
    `《北境玄天录》\n\n` +
    `第1章 测灵\n\n${PASS_TEXT}\n\n` +
    `第2章 觉醒\n\n${PASS_TEXT}\n\n` +
    `第3章 下山\n\n${PASS_TEXT}\n\n`;
  expect(res.text).toBe(expected);
});

it('全书导出 markdown：标题层级正确', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
  const { env, bookId } = await seedExportBook(llm);

  const res = await env.request.get(`/api/books/${bookId}/export?format=markdown`);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('text/markdown');
  const expected =
    `# 北境玄天录\n\n` +
    `## 第1章 测灵\n\n${PASS_TEXT}\n\n` +
    `## 第2章 觉醒\n\n${PASS_TEXT}\n\n` +
    `## 第3章 下山\n\n${PASS_TEXT}\n\n`;
  expect(res.text).toBe(expected);
});

it('分卷导出：仅含该卷章节，头部带卷名', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
  const { env, bookId, volume2 } = await seedExportBook(llm);

  const txt = await env.request.get(`/api/books/${bookId}/export?format=txt&volumeId=${volume2.id}`);
  expect(txt.status).toBe(200);
  expect(txt.text).toBe(`《北境玄天录》·第二卷·外出游历\n\n第3章 下山\n\n${PASS_TEXT}\n\n`);
  expect(txt.text).not.toContain('第1章');

  const md = await env.request.get(`/api/books/${bookId}/export?format=markdown&volumeId=${volume2.id}`);
  expect(md.status).toBe(200);
  expect(md.text).toBe(`# 北境玄天录·第二卷·外出游历\n\n## 第3章 下山\n\n${PASS_TEXT}\n\n`);
});

it('未生成章不进导出；全书无落稿章节时 409', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
  const env = createTestApp(llm);
  const { request } = env;
  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  for (const title of ['第1章 甲', '第2章 乙']) {
    const outline = await seedChapterOutline(request, book.id, volume.id, { title });
    await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, { status: 'approved' });
  }
  for (const task of ['draft', 'verify'] as const) {
    await configureRoute(request, task);
  }
  await request.post(`/api/books/${book.id}/chapters/1/generate`, {});

  const partial = await request.get(`/api/books/${book.id}/export?format=txt`);
  expect(partial.status).toBe(200);
  expect(partial.text).toContain('第1章 甲');
  expect(partial.text).not.toContain('第2章 乙');

  const emptyBook = await seedBook(request, { title: '空书' });
  const empty = await request.get(`/api/books/${emptyBook.id}/export?format=txt`);
  expect(empty.status).toBe(409);
  expect(empty.body.error).toContain('落稿');
});

it('导出参数校验：非法 format 400、不存在的卷 404', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
  const { env, bookId } = await seedExportBook(llm);

  expect((await env.request.get(`/api/books/${bookId}/export`)).status).toBe(400);
  expect((await env.request.get(`/api/books/${bookId}/export?format=epub`)).status).toBe(400);
  expect((await env.request.get(`/api/books/${bookId}/export?format=txt&volumeId=999`)).status).toBe(404);
});
