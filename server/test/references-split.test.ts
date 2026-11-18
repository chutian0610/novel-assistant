import { expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { createTestApp, seedMaterial, seedReference, type TestChapterInput } from './helpers';

/** 用 fflate 构造最小 epub：container.xml → OPF（manifest+spine）→ 逐章 XHTML */
function buildEpub(chapters: TestChapterInput[], bookTitle = '拆书测试·epub'): Buffer {
  const files: Record<string, Uint8Array> = {
    'META-INF/container.xml': strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    ),
    'OEBPS/content.opf': strToU8(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${bookTitle}</dc:title></metadata><manifest>${chapters
        .map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`)
        .join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`
    ),
  };
  for (const [i, chapter] of chapters.entries()) {
    files[`OEBPS/c${i}.xhtml`] = strToU8(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapter.title}</title></head><body><h2>${chapter.title}</h2><p>${chapter.content}</p><p>实体解码：&amp; &lt; &quot;出路&quot;</p></body></html>`
    );
  }
  return Buffer.from(zipSync(files));
}

it('txt 上传按章节标记自动分章，章节标题与正文正确', async () => {
  const { request } = createTestApp();
  const reference = await seedReference(request, [
    { title: '序章', content: '雪下了整夜，北境的驿站里只剩一盏灯。' },
    { title: '第一章 北境', content: '少年背着一柄旧剑出城，身后的门匾裂了半边。' },
    { title: '第二章 入宗', content: '宗门大比在即，山道上的石阶被人踩得发亮。' },
  ]);

  expect(reference.title).toBe('参考书·拆书测试');
  expect(reference.format).toBe('txt');
  expect(reference.chapterCount).toBe(3);
  expect(reference.chapters.map((c) => c.title)).toEqual(['序章', '第一章 北境', '第二章 入宗']);
  expect(reference.chapters.map((c) => c.extractStatus)).toEqual(['pending', 'pending', 'pending']);
  expect(reference.chapters[1]!.content).toContain('旧剑出城');
  expect(reference.chapters.every((c) => c.charCount > 0)).toBe(true);
});

it('txt 无章节标记时整本归入单章', async () => {
  const { request } = createTestApp();
  const res = await request.postRaw(
    '/api/references?format=txt&title=' + encodeURIComponent('无标记'),
    '这是一段没有章节标记的正文，讲一个漫长冬天的故事。',
    'text/plain; charset=utf-8'
  );
  expect(res.status).toBe(201);
  expect(res.body.chapterCount).toBe(1);
  expect(res.body.chapters[0]!.title).toBe('全文');
  expect(res.body.chapters[0]!.content).toContain('漫长冬天');
});

it('GBK/GB18030 编码的 txt 自动回退解码并正确分章', async () => {
  const { request } = createTestApp();
  // GB18030 字节序列手写构造：「第一章 甲\nThe body.」（中文双字节 + ASCII 单字节）
  const gbBytes = new Uint8Array([
    0xb5, 0xda, // 第
    0xd2, 0xbb, // 一
    0xd5, 0xc2, // 章
    0x20, // 空格
    0xbc, 0xd7, // 甲
    0x0a, // 换行
    ...Buffer.from('The body.', 'ascii'),
  ]);

  const res = await request.postRaw(
    '/api/references?format=txt&title=' + encodeURIComponent('GBK书'),
    Buffer.from(gbBytes),
    'text/plain; charset=utf-8'
  );
  expect(res.status).toBe(201);
  expect(res.body.chapters[0]!.title).toBe('第一章 甲');
  expect(res.body.chapters[0]!.content).toContain('The body.');
});

it('epub 上传按 spine 顺序解析文本并分章，书名取自元数据', async () => {
  const { request } = createTestApp();
  const epub = buildEpub(
    [
      { title: '楔子', content: '古钟自鸣，山门大开。' },
      { title: '第一章 拜师', content: '他在演武场站了一夜。' },
    ],
    '拆书测试·epub'
  );
  const res = await request.postRaw('/api/references?format=epub', epub, 'application/epub+zip');
  expect(res.status).toBe(201);
  expect(res.body.title).toBe('拆书测试·epub');
  expect(res.body.format).toBe('epub');
  expect(res.body.chapters.map((c) => c.title)).toEqual(['楔子', '第一章 拜师']);
  expect(res.body.chapters[0]!.content).toContain('古钟自鸣');
  expect(res.body.chapters[0]!.content).toContain('"出路"'); // HTML 实体解码
  expect(res.body.chapters[0]!.content).not.toMatch(/<\/?(p|h[1-6]|html|body|head)\b/i); // 标签已剥离
});

it('上传校验：未知 format / 空 txt / 分不出章节 / 文件超限分别报错', async () => {
  const { request } = createTestApp();
  expect((await request.postRaw('/api/references?format=pdf', 'x', 'application/pdf')).status).toBe(400);
  expect(
    (await request.postRaw('/api/references?format=txt&title=x', '   \n  ', 'text/plain; charset=utf-8')).status
  ).toBe(400);
  expect((await request.postRaw('/api/references?format=epub', Buffer.from('不是 zip'), 'application/epub+zip')).status).toBe(400);

  const oversized = '第一章 超限\n' + '字'.repeat(5 * 1024 * 1024);
  expect(
    (await request.postRaw('/api/references?format=txt&title=x', oversized, 'text/plain; charset=utf-8')).status
  ).toBe(413);
});

it('参考书列表含抽取进度；详情可回读；删除级联清理章与队列但不动已入库素材', async () => {
  const env = createTestApp();
  const reference = await seedReference(env.request, [
    { title: '第一章 甲', content: '甲章正文。' },
    { title: '第二章 乙', content: '乙章正文。' },
  ]);

  let list = (await env.request.get('/api/references')).body as {
    items: { id: number; title: string; chapterCount: number; extractedCount: number; pendingItemCount: number }[];
    total: number;
  };
  expect(list.total).toBe(1);
  expect(list.items[0]).toMatchObject({ title: '参考书·拆书测试', chapterCount: 2, extractedCount: 0, pendingItemCount: 0 });

  const detail = await env.request.get(`/api/references/${reference.id}`);
  expect(detail.status).toBe(200);
  expect(detail.body.chapters).toHaveLength(2);

  // 删除级联：章与抽取条目清空，全局素材与书不受影响
  const material = await seedMaterial(env.request, { type: 'setting' });
  const del = await env.request.delete(`/api/references/${reference.id}`);
  expect(del.status).toBe(204);
  expect(((await env.request.get('/api/references')).body as { total: number }).total).toBe(0);
  expect((await env.request.get(`/api/references/${reference.id}`)).status).toBe(404);
  expect(env.db.prepare('SELECT COUNT(*) AS count FROM reference_chapters').get()).toMatchObject({ count: 0 });
  expect(env.db.prepare('SELECT COUNT(*) AS count FROM extraction_items').get()).toMatchObject({ count: 0 });
  expect((await env.request.get(`/api/materials/${material.id}`)).status).toBe(200);

  expect((await env.request.delete('/api/references/999')).status).toBe(404);
});
