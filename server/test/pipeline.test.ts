import { expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import type { ChatResult } from '../src/llm/types';
import {
  configureRoute,
  createTestApp,
  seedBook,
  seedBookMaterial,
  seedCharacterState,
  seedChapterOutline,
  seedMaterial,
  seedVolume,
} from './helpers';

/** 把正文草稿包装成 FakeLLM 的脚本化响应 */
function draftResult(content: string): ChatResult {
  return { content, model: 'fake-draft' };
}

/** 通过 API 启动/续跑第 idx 章的生成管线 */
async function generate(env: ReturnType<typeof createTestApp>, bookId: number, idx: number) {
  return env.request.post(`/api/books/${bookId}/chapters/${idx}/generate`);
}

/** 预置一卷一章（默认草稿态章纲），返回章纲 id */
async function seedApprovedChapter(env: ReturnType<typeof createTestApp>, overrides = {}) {
  const { request } = env;
  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  const outline = await seedChapterOutline(request, book.id, volume.id, overrides);
  const res = await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, {
    status: 'approved',
  });
  if (res.status !== 200) throw new Error(`批准章纲失败：${res.status} ${JSON.stringify(res.body)}`);
  return { book, volume, outline };
}

const DRAFT_TEXT = '夜色压城，陆沉舟握紧残玉。测灵仪的裂痕在月光下泛着冷光，他知道，从今晚起，玄天宗再无他的退路。';

it('无章纲时拒绝启动并提示', async () => {
  const env = createTestApp();
  await seedBook(env.request);
  const res = await generate(env, 1, 1);
  expect(res.status).toBe(409);
  expect(res.body.error).toContain('章纲');
});

it('章纲未批准时拒绝启动并提示', async () => {
  const env = createTestApp();
  const { request } = env;
  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  await seedChapterOutline(request, book.id, volume.id); // 草稿态
  const res = await generate(env, book.id, 1);
  expect(res.status).toBe(409);
  expect(res.body.error).toContain('批准');

  // 被拒的启动不留运行残留：无章节、无管线记录
  const list = await request.get(`/api/books/${book.id}/chapters`);
  expect(list.body.items).toEqual([]);
  const runs = env.db.prepare('SELECT COUNT(*) AS count FROM pipeline_runs').get() as { count: number };
  expect(runs.count).toBe(0);
});

it('章号超出章纲范围时拒绝启动', async () => {
  const env = createTestApp();
  const { book } = await seedApprovedChapter(env);
  const res = await generate(env, book.id, 5);
  expect(res.status).toBe(409);
  expect(res.body.error).toContain('超出章纲范围');
});

it('全管线 happy path：prepare 装填 → draft 生成 → commit 单事务落盘三派生物', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(DRAFT_TEXT) } });
  const env = createTestApp(llm);
  const { request } = env;
  const { book, outline } = await seedApprovedChapter(env);
  const material = await seedMaterial(request, { type: 'trope', title: '退路断绝', content: '主角被宗门除名，孤身入夜。' });
  await seedBookMaterial(request, book.id, material.id);
  await seedCharacterState(request, book.id, { name: '陆沉舟', chapter: 1, category: 'possession', content: '持有残玉。' });
  await configureRoute(request, 'draft');

  const res = await generate(env, book.id, 1);
  expect(res.status).toBe(200);

  // 章节：标题快照自章纲，正文为 draft 产物
  expect(res.body.chapter).toMatchObject({ idx: 1, title: outline.title, content: DRAFT_TEXT });
  expect(res.body.chapter.charCount).toBe(DRAFT_TEXT.length);

  // 派生物一：版本快照（pipeline 来源）
  expect(res.body.snapshots).toHaveLength(1);
  expect(res.body.snapshots[0]).toMatchObject({ source: 'pipeline', content: DRAFT_TEXT });

  // 派生物二：滚动摘要（短文全文保留）
  expect(res.body.chapter.summary).toBe(DRAFT_TEXT);

  // 管线状态：三阶段全部执行完
  expect(res.body.run).toMatchObject({ stage: 'done', status: 'done', attempts: 3, error: null });
  expect(res.body.run.preparedView).not.toBeNull();
  expect(res.body.run.preparedView.layers.map((l: { key: string }) => l.key)).toEqual([
    'contract',
    'outline',
    'characters',
    'relevance',
  ]);

  // LLM 只被 draft 阶段调用一次；prompt 装填注入视图内容
  expect(llm.calls).toHaveLength(1);
  expect(llm.calls[0]!.task).toBe('draft');
  const [system, user] = llm.calls[0]!.req.messages;
  expect(system!.role).toBe('system');
  expect(system!.content).toContain('正文');
  expect(user!.content).toContain('东方玄幻'); // 书契约层
  expect(user!.content).toContain('测灵仪前受辱'); // 章纲层
  expect(user!.content).toContain('持有残玉'); // 角色运行时层
  expect(user!.content).toContain('孤身入夜'); // 相关素材层
});

it('长正文滚动摘要截断到 200 字并压平空白', async () => {
  const longText = `第一行。\n第二行。${'情'.repeat(300)}`;
  const llm = new FakeLLM({ respond: { draft: draftResult(longText) } });
  const env = createTestApp(llm);
  const { book } = await seedApprovedChapter(env);
  await configureRoute(env.request, 'draft');

  const res = await generate(env, book.id, 1);
  expect(res.status).toBe(200);
  const expected = ('第一行。第二行。' + '情'.repeat(300)).replace(/\s+/g, '').slice(0, 200);
  expect(res.body.chapter.summary).toBe(`${expected}……`);
});

it('draft 阶段失败落盘，重启后从断点续跑且不重复装填', async () => {
  const llm = new FakeLLM({ respond: { draft: new Error('连接超时') } });
  const env = createTestApp(llm);
  const { request } = env;
  const { book, outline } = await seedApprovedChapter(env);
  await configureRoute(request, 'draft');

  const first = await generate(env, book.id, 1);
  expect(first.status).toBe(502);
  expect(first.body.error).toContain('连接超时');

  // 失败即落盘：prepare 产物已持久化，stage 停在 draft
  const runRow = env.db
    .prepare('SELECT * FROM pipeline_runs WHERE book_id = ? AND idx = ?')
    .get(book.id, 1) as { stage: string; status: string; attempts: number; prepared_view: string | null; draft_content: null };
  expect(runRow.stage).toBe('draft');
  expect(runRow.status).toBe('failed');
  expect(runRow.attempts).toBe(2);
  expect(runRow.prepared_view).not.toBeNull();
  expect(runRow.draft_content).toBeNull();

  // 中途改动章纲，验证续跑复用已装填视图（不重算 prepare）
  await request.patch(`/api/books/${book.id}/outlines/chapters/${outline.id}`, {
    summary: '续跑期间被改掉的章纲。',
  });

  llm.script.respond = { draft: draftResult(DRAFT_TEXT) };
  const second = await generate(env, book.id, 1);
  expect(second.status).toBe(200);
  expect(second.body.run).toMatchObject({ stage: 'done', status: 'done', attempts: 4 });

  // 断点续跑：两次 draft 调用的装填内容一致（第二次没有重新 prepare），章纲改动未渗入
  expect(llm.calls).toHaveLength(2);
  expect(llm.calls[1]!.req.messages[1]!.content).toBe(llm.calls[0]!.req.messages[1]!.content);
  expect(second.body.run.preparedView).toEqual(JSON.parse(runRow.prepared_view!));
});

it('draft 落盘后进程中断，重启直接从 commit 续跑，FakeLLM 调用次数不翻倍', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(DRAFT_TEXT) } });
  const env = createTestApp(llm);
  const { book } = await seedApprovedChapter(env);
  await configureRoute(env.request, 'draft');

  const first = await generate(env, book.id, 1);
  expect(first.status).toBe(200);
  expect(llm.calls).toHaveLength(1);

  // 模拟「draft 已落盘、commit 未执行」时进程被杀：回退 run 状态，清掉 commit 产物
  env.db
    .prepare("UPDATE pipeline_runs SET stage = 'draft', status = 'running' WHERE book_id = ? AND idx = ?")
    .run(book.id, 1);
  env.db.prepare('DELETE FROM chapters').run();

  const second = await generate(env, book.id, 1);
  expect(second.status).toBe(200);
  // 关键断言：draft 不重跑，零新增 LLM 调用
  expect(llm.calls).toHaveLength(1);
  expect(second.body.chapter.content).toBe(DRAFT_TEXT);
  expect(second.body.run).toMatchObject({ stage: 'done', status: 'done', attempts: 4 });
  expect(second.body.snapshots).toHaveLength(1);
});

it('draft 路由未配置时拒绝并落盘，配置后续跑不重复装填', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(DRAFT_TEXT) } });
  const env = createTestApp(llm);
  const { book } = await seedApprovedChapter(env);

  const first = await generate(env, book.id, 1);
  expect(first.status).toBe(409);
  expect(first.body.error).toContain('路由');

  await configureRoute(env.request, 'draft');
  const second = await generate(env, book.id, 1);
  expect(second.status).toBe(200);
  expect(llm.calls).toHaveLength(1); // prepare 复用，draft 只调一次
  expect(second.body.chapter.content).toBe(DRAFT_TEXT);
});

it('LLM 返回空正文视为 draft 失败', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult('   \n  ') } });
  const env = createTestApp(llm);
  const { book } = await seedApprovedChapter(env);
  await configureRoute(env.request, 'draft');

  const res = await generate(env, book.id, 1);
  expect(res.status).toBe(502);
  expect(res.body.error).toContain('空');
  const chapterCount = env.db.prepare('SELECT COUNT(*) AS count FROM chapters').get() as { count: number };
  expect(chapterCount.count).toBe(0);
});

it('已完成章节可重新生成：run 重置、新增流水线快照', async () => {
  const llm = new FakeLLM();
  const env = createTestApp(llm);
  const { book } = await seedApprovedChapter(env);
  await configureRoute(env.request, 'draft');

  llm.script.respond = { draft: draftResult(DRAFT_TEXT) };
  await generate(env, book.id, 1);
  llm.script.respond = { draft: draftResult('重写后的正文。') };
  const second = await generate(env, book.id, 1);
  expect(second.status).toBe(200);
  expect(second.body.chapter.content).toBe('重写后的正文。');
  expect(second.body.run.attempts).toBe(3); // 全新 run，从零计三阶段
  expect(second.body.snapshots).toHaveLength(2);
  expect(second.body.snapshots[0]).toMatchObject({ source: 'pipeline', content: '重写后的正文。' });
});

it('重新生成同样要求已批准章纲：章纲被删后拒绝，且不影响既有章节与编辑', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(DRAFT_TEXT) } });
  const env = createTestApp(llm);
  const { request } = env;
  const { book, outline } = await seedApprovedChapter(env);
  await configureRoute(request, 'draft');
  await generate(env, book.id, 1);

  await request.delete(`/api/books/${book.id}/outlines/chapters/${outline.id}`);
  const res = await generate(env, book.id, 1);
  expect(res.status).toBe(409);
  expect(res.body.error).toContain('章纲');

  // 被拒的重新生成不触碰既有状态：run 仍 done，章节与编辑入口完好
  const runRow = env.db
    .prepare('SELECT status, stage FROM pipeline_runs WHERE book_id = ? AND idx = ?')
    .get(book.id, 1) as { status: string; stage: string };
  expect(runRow).toMatchObject({ status: 'done', stage: 'done' });
  const edited = await request.patch(`/api/books/${book.id}/chapters/1`, { content: '手工打磨的正文。' });
  expect(edited.status).toBe(200);
});

it('正文可编辑：生成快照 + 摘要同步重算', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(DRAFT_TEXT) } });
  const env = createTestApp(llm);
  const { book } = await seedApprovedChapter(env);
  await configureRoute(env.request, 'draft');
  await generate(env, book.id, 1);

  const edited = '改好的开头。\n改好的中段。';
  const res = await env.request.patch(`/api/books/${book.id}/chapters/1`, { content: edited });
  expect(res.status).toBe(200);
  expect(res.body.content).toBe(edited);
  expect(res.body.summary).toBe('改好的开头。改好的中段。');

  const detail = await env.request.get(`/api/books/${book.id}/chapters/1`);
  expect(detail.status).toBe(200);
  expect(detail.body.snapshots.map((s: { source: string }) => s.source)).toEqual(['edit', 'pipeline']);
  expect(detail.body.snapshots[0].content).toBe(edited);
});

it('可回退历史快照：正文恢复、回退动作本身成为新快照', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(DRAFT_TEXT) } });
  const env = createTestApp(llm);
  const { book } = await seedApprovedChapter(env);
  await configureRoute(env.request, 'draft');
  await generate(env, book.id, 1);
  await env.request.patch(`/api/books/${book.id}/chapters/1`, { content: '编辑后的正文。' });

  const detail = await env.request.get(`/api/books/${book.id}/chapters/1`);
  const pipelineSnapshot = detail.body.snapshots.find((s: { source: string }) => s.source === 'pipeline');

  const res = await env.request.post(`/api/books/${book.id}/chapters/1/revert`, {
    snapshotId: pipelineSnapshot.id,
  });
  expect(res.status).toBe(200);
  expect(res.body.content).toBe(DRAFT_TEXT);
  expect(res.body.summary).toBe(DRAFT_TEXT);

  const after = await env.request.get(`/api/books/${book.id}/chapters/1`);
  expect(after.body.snapshots.map((s: { source: string }) => s.source)).toEqual(['revert', 'edit', 'pipeline']);
});

it('回退不存在的章节或快照返回 404', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(DRAFT_TEXT) } });
  const env = createTestApp(llm);
  const { book } = await seedApprovedChapter(env);
  await configureRoute(env.request, 'draft');
  await generate(env, book.id, 1);

  expect((await env.request.post(`/api/books/${book.id}/chapters/9/revert`, { snapshotId: 1 })).status).toBe(404);
  expect((await env.request.post(`/api/books/${book.id}/chapters/1/revert`, { snapshotId: 999 })).status).toBe(404);
  expect((await env.request.get(`/api/books/${book.id}/chapters/9`)).status).toBe(404);
  expect((await env.request.patch(`/api/books/${book.id}/chapters/9`, { content: 'x' })).status).toBe(404);
});

it('管线未完成时禁止编辑与回退', async () => {
  const llm = new FakeLLM({ respond: { draft: new Error('连接超时') } });
  const env = createTestApp(llm);
  const { book } = await seedApprovedChapter(env);
  await configureRoute(env.request, 'draft');
  await generate(env, book.id, 1); // draft 失败，run 停在 failed

  const patch = await env.request.patch(`/api/books/${book.id}/chapters/1`, { content: 'x' });
  expect(patch.status).toBe(404); // 章节尚不存在（commit 未执行）

  // 走到 commit 后再制造 failed run：编辑与回退都被拒
  llm.script.respond = { draft: draftResult(DRAFT_TEXT) };
  await generate(env, book.id, 1);
  env.db
    .prepare("UPDATE pipeline_runs SET status = 'failed', error = '模拟中断' WHERE book_id = ? AND idx = ?")
    .run(book.id, 1);

  const editBlocked = await env.request.patch(`/api/books/${book.id}/chapters/1`, { content: 'x' });
  expect(editBlocked.status).toBe(409);
  expect(editBlocked.body.error).toContain('完成');

  const revertBlocked = await env.request.post(`/api/books/${book.id}/chapters/1/revert`, { snapshotId: 1 });
  expect(revertBlocked.status).toBe(409);
});

it('编辑正文校验：空内容 400、非整数章号 400', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(DRAFT_TEXT) } });
  const env = createTestApp(llm);
  const { book } = await seedApprovedChapter(env);
  await configureRoute(env.request, 'draft');
  await generate(env, book.id, 1);

  expect((await env.request.patch(`/api/books/${book.id}/chapters/1`, { content: '  ' })).status).toBe(400);
  expect((await env.request.patch(`/api/books/${book.id}/chapters/abc`, { content: 'x' })).status).toBe(400);
  expect((await env.request.patch(`/api/books/${book.id}/chapters/1`, {})).status).toBe(400);
});

it('章节列表：含章节与运行状态摘要', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(DRAFT_TEXT) } });
  const env = createTestApp(llm);
  const { request } = env;
  const { book, outline } = await seedApprovedChapter(env);
  const secondOutline = await seedChapterOutline(request, book.id, 1, {
    title: '第2章 宗门除名',
    summary: '长老会表决，当众除名。',
  });
  await request.post(`/api/books/${book.id}/outlines/chapters/${secondOutline.id}/status`, { status: 'approved' });
  await configureRoute(request, 'draft');

  const empty = await request.get(`/api/books/${book.id}/chapters`);
  expect(empty.body).toEqual({ items: [], total: 0 });

  await generate(env, book.id, 2); // 生成第 2 章
  const res = await request.get(`/api/books/${book.id}/chapters`);
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(1);
  // 列表带摘要与字数（正文在详情接口，避免整书列表承载全部正文）
  expect(res.body.items[0]).toMatchObject({
    idx: 2,
    title: secondOutline.title,
    summary: DRAFT_TEXT,
    charCount: DRAFT_TEXT.length,
  });
  expect(res.body.items[0].content).toBeUndefined();
  expect(res.body.items[0].run).toMatchObject({ stage: 'done', status: 'done', attempts: 3 });
  expect(res.body.items[0].run.preparedView).toBeUndefined(); // 列表不带重负载
});

it('章纲在锁定态也可生成（锁定的意义即生成不漂移）', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(DRAFT_TEXT) } });
  const env = createTestApp(llm);
  const { request } = env;
  const { book, outline } = await seedApprovedChapter(env);
  await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, { status: 'locked' });
  await configureRoute(request, 'draft');

  const res = await generate(env, book.id, 1);
  expect(res.status).toBe(200);
  expect(res.body.chapter.title).toBe(outline.title);
});

it('删除书级联清理章节、快照与管线状态', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(DRAFT_TEXT) } });
  const env = createTestApp(llm);
  const { book } = await seedApprovedChapter(env);
  await configureRoute(env.request, 'draft');
  await generate(env, book.id, 1);

  await env.request.delete(`/api/books/${book.id}`);
  for (const table of ['chapters', 'chapter_snapshots', 'pipeline_runs']) {
    const row = env.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    expect(row.count).toBe(0);
  }
});
