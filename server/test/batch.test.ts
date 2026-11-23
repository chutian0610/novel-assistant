import { expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import { draftResult, PASS_TEXT, semanticResult } from './text-fixtures';
import {
  configureRoute,
  createTestApp,
  seedBook,
  seedChapterOutline,
  seedRelation,
  seedVolume,
} from './helpers';
import type { ChatResult } from '../src/llm/types';

/** 回灌夹具：证据均为 PASS_TEXT 子串 */
const EXTRACT_PAYLOAD = {
  characterStates: [
    { name: '陆沉舟', category: 'injury', content: '恐惧像潮水一样漫过心头，但他稳住了。', evidence: '恐惧像潮水一样漫过心头' },
  ],
  relations: [],
  timeline: [{ title: '夜战退敌', content: '守军击退城下敌军。', evidence: '帐帘掀开' }],
  foreshadows: [],
};

function extractResult(payload: unknown): ChatResult {
  return { content: JSON.stringify(payload), model: 'fake-extract' };
}

/** 预置 N 条已批准章纲 + 三条路由 */
async function seedBatchBook(llm: FakeLLM, outlineCount: number) {
  const env = createTestApp(llm);
  const { request } = env;
  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  for (let i = 1; i <= outlineCount; i++) {
    const outline = await seedChapterOutline(request, book.id, volume.id, { title: `第${i}章 夜战${i}` });
    const res = await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, {
      status: 'approved',
    });
    if (res.status !== 200) throw new Error(`批准章纲失败：${res.status}`);
  }
  for (const task of ['draft', 'verify', 'extract'] as const) {
    await configureRoute(request, task);
  }
  await seedRelation(request, book.id); // 让事实库非空（回灌/核查上下文有内容）
  return { env, bookId: book.id };
}

/** 切换管线预设 */
async function setConfig(
  request: ReturnType<typeof createTestApp>['request'],
  patch: { mode?: string; autoRunLimit?: number }
) {
  return request.put('/api/settings/pipeline', patch);
}

/** 发起全自动连跑 */
async function batch(env: ReturnType<typeof createTestApp>, bookId: number) {
  return env.request.post(`/api/books/${bookId}/chapters/batch-generate`, {});
}

async function queue(env: ReturnType<typeof createTestApp>, bookId: number) {
  return env.request.get(`/api/books/${bookId}/pipeline-queue`);
}

// ---------- 预设设置 ----------

it('管线预设默认值：协作模式 + 连跑上限 5', async () => {
  const env = createTestApp();
  const res = await env.request.get('/api/settings/pipeline');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ mode: 'collaborative', autoRunLimit: 5, recentSummariesLimit: 3 });
});

it('设置中可切换预设与调整连跑上限', async () => {
  const env = createTestApp();
  const put = await setConfig(env.request, { mode: 'auto', autoRunLimit: 3 });
  expect(put.status).toBe(200);
  expect(put.body).toEqual({ mode: 'auto', autoRunLimit: 3, recentSummariesLimit: 3 });

  const get = await env.request.get('/api/settings/pipeline');
  expect(get.body).toEqual({ mode: 'auto', autoRunLimit: 3, recentSummariesLimit: 3 });

  // 非法取值被拒
  expect((await setConfig(env.request, { mode: 'yolo' })).status).toBe(400);
  expect((await setConfig(env.request, { autoRunLimit: 0 })).status).toBe(400);
  expect((await setConfig(env.request, { autoRunLimit: 21 })).status).toBe(400);
});

// ---------- 连跑 ----------

it('协作预设下连跑被拒（逐章审阅语义）', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), extract: extractResult(EXTRACT_PAYLOAD) } });
  const { env, bookId } = await seedBatchBook(llm, 2);

  const res = await batch(env, bookId);
  expect(res.status).toBe(409);
  expect(res.body.error).toContain('协作');

  // 协作模式不产生任何运行
  const runs = env.db.prepare('SELECT COUNT(*) AS count FROM pipeline_runs').get() as { count: number };
  expect(runs.count).toBe(0);
});

it('全自动连跑至上限自动暂停待审', async () => {
  const llm = new FakeLLM({
    respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), extract: extractResult(EXTRACT_PAYLOAD) },
  });
  const { env, bookId } = await seedBatchBook(llm, 4);
  await setConfig(env.request, { mode: 'auto', autoRunLimit: 3 });

  const res = await batch(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.completed.map((item: { idx: number }) => item.idx)).toEqual([1, 2, 3]);
  expect(res.body.stopped).toMatchObject({ reason: 'limit', idx: null });
  expect(res.body.stopped.message).toContain('上限');
  expect(res.body.nextIdx).toBe(4);

  // 三章全部落稿，第 4 章未启动
  const chapters = env.db.prepare('SELECT COUNT(*) AS count FROM chapters').get() as { count: number };
  expect(chapters.count).toBe(3);
  const runRow = env.db.prepare('SELECT status FROM pipeline_runs WHERE idx = 4').get();
  expect(runRow).toBeUndefined();

  // 每章 draft/verify/extract 各一次
  expect(llm.calls.filter((call) => call.task === 'draft')).toHaveLength(3);
  expect(llm.calls.filter((call) => call.task === 'verify')).toHaveLength(3);
  expect(llm.calls.filter((call) => call.task === 'extract')).toHaveLength(3);

  // 再次连跑从断点章继续（已完成章不重跑）
  llm.script.respond = {
    draft: draftResult(PASS_TEXT.replace('夜风掠过城头', '朔风撕过城头')),
    verify: semanticResult([]),
    extract: extractResult(EXTRACT_PAYLOAD),
  };
  const second = await batch(env, bookId);
  expect(second.body.completed.map((item: { idx: number }) => item.idx)).toEqual([4]);
  expect(second.body.nextIdx).toBe(5);
  expect(llm.calls.filter((call) => call.task === 'draft')).toHaveLength(4); // 只补第 4 章
});

it('挂起章节阻塞后续，处理后再次连跑可恢复', async () => {
  const conflicts = [{ quote: '皇帝在金銮殿上抚掌大笑，当场赐下蟒袍玉带。', explanation: '皇帝已被软禁', factHint: '' }];
  const llm = new FakeLLM({
    respond: { draft: draftResult(PASS_TEXT), extract: extractResult(EXTRACT_PAYLOAD) },
    respondSequence: {
      verify: [semanticResult([]), semanticResult(conflicts)], // 第 2 章核查出矛盾
    },
  });
  const { env, bookId } = await seedBatchBook(llm, 3);
  await setConfig(env.request, { mode: 'auto', autoRunLimit: 5 });

  const res = await batch(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.completed.map((item: { idx: number }) => item.idx)).toEqual([1]);
  expect(res.body.stopped).toMatchObject({ reason: 'suspended', idx: 2 });
  expect(res.body.stopped.message).toContain('挂起');
  expect(res.body.nextIdx).toBe(2);

  // 第 3 章未启动（无运行记录）
  expect(env.db.prepare('SELECT status FROM pipeline_runs WHERE idx = 3').get()).toBeUndefined();

  // 队列视图实时反映各章阶段与断点
  const view = await queue(env, bookId);
  expect(view.status).toBe(200);
  expect(view.body.items).toHaveLength(3);
  expect(view.body.items[0]).toMatchObject({ idx: 1, run: { status: 'done' } });
  expect(view.body.items[1]).toMatchObject({ idx: 2, run: { status: 'suspended', stage: 'fix' } });
  expect(view.body.items[1].chapter).toBeNull(); // 挂起未落稿
  expect(view.body.items[2]).toMatchObject({ idx: 3, run: null });

  // 处理挂起项（忽略放行）→ 自动提交第 2 章
  const [item] = (await env.request.get(`/api/books/${bookId}/suspensions?status=pending`)).body.items;
  const resolve = await env.request.post(`/api/books/${bookId}/chapters/2/suspensions/${item.id}/resolve`, {
    resolution: 'ignore',
  });
  expect(resolve.body.run).toMatchObject({ status: 'done' });

  // 再次连跑从第 3 章恢复（verify 序列已耗尽，回退到静态无冲突响应）
  llm.script.respond = {
    draft: draftResult(PASS_TEXT),
    verify: semanticResult([]),
    extract: extractResult(EXTRACT_PAYLOAD),
  };
  const second = await batch(env, bookId);
  expect(second.body.completed.map((item: { idx: number }) => item.idx)).toEqual([3]);
  // 本用例只有 3 条章纲：第 3 章完成后即前置停止（章纲用尽）
  expect(second.body.stopped).toMatchObject({ reason: 'precondition', idx: 4 });
});

it('阶段失败停止连跑并暴露错误', async () => {
  const llm = new FakeLLM({
    respond: { verify: semanticResult([]), extract: extractResult(EXTRACT_PAYLOAD) },
    respondSequence: { draft: [draftResult(PASS_TEXT), new Error('连接超时')] },
  });
  const { env, bookId } = await seedBatchBook(llm, 3);
  await setConfig(env.request, { mode: 'auto', autoRunLimit: 5 });

  const res = await batch(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.completed.map((item: { idx: number }) => item.idx)).toEqual([1]);
  expect(res.body.stopped).toMatchObject({ reason: 'error', idx: 2 });
  expect(res.body.stopped.message).toContain('连接超时');
  expect(res.body.nextIdx).toBe(2);

  // 第 3 章未被尝试
  expect(env.db.prepare('SELECT status FROM pipeline_runs WHERE idx = 3').get()).toBeUndefined();
});

it('章纲用尽即前置停止（无已批准章纲）', async () => {
  const llm = new FakeLLM({
    respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), extract: extractResult(EXTRACT_PAYLOAD) },
  });
  const { env, bookId } = await seedBatchBook(llm, 2);
  await setConfig(env.request, { mode: 'auto', autoRunLimit: 5 });

  const res = await batch(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.completed.map((item: { idx: number }) => item.idx)).toEqual([1, 2]);
  expect(res.body.stopped).toMatchObject({ reason: 'precondition', idx: 3 });
  expect(res.body.stopped.message).toContain('章纲');
});

it('全部章纲已提交时连跑空转返回提示', async () => {
  const llm = new FakeLLM({
    respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), extract: extractResult(EXTRACT_PAYLOAD) },
  });
  const { env, bookId } = await seedBatchBook(llm, 1);
  await setConfig(env.request, { mode: 'auto', autoRunLimit: 5 });
  await batch(env, bookId); // 第 1 章完成，之后前置停止

  const second = await batch(env, bookId);
  expect(second.status).toBe(200);
  expect(second.body.completed).toEqual([]);
  expect(second.body.stopped).toMatchObject({ reason: 'none', idx: null });
  expect(second.body.stopped.message).toContain('没有待生成');
});
