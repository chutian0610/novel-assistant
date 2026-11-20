import { expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import {
  BAD_SENTENCE,
  draftResult,
  FAIL_TEXT,
  FIXED_TEXT,
  GOOD_SENTENCE,
  PASS_TEXT,
  SEM_QUOTE_NEW,
  SEM_QUOTE_OLD,
  semanticResult,
  STILL_BAD_REWRITE,
} from './text-fixtures';
import {
  configureRoute,
  createTestApp,
  seedBook,
  seedCharacterState,
  seedChapterOutline,
  seedRelation,
  seedVolume,
} from './helpers';

interface SeedOptions {
  draftSequence?: { content: string; model: string }[];
  configureVerify?: boolean;
}

/** 预置书 + 卷 + 两条已批准章纲 + draft/verify 路由 + 事实库种子，返回书 id */
async function seedPipelineBook(llm: FakeLLM, options: SeedOptions = {}) {
  const env = createTestApp(llm);
  const { request } = env;
  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  for (const title of ['第1章 夜战', '第2章 捷报']) {
    const outline = await seedChapterOutline(request, book.id, volume.id, { title });
    const res = await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, {
      status: 'approved',
    });
    if (res.status !== 200) throw new Error(`批准章纲失败：${res.status}`);
  }
  await configureRoute(request, 'draft');
  if (options.configureVerify !== false) await configureRoute(request, 'verify');
  // 事实库种子：供语义核查 prompt 断言
  await seedRelation(request, book.id, { fromName: '陆沉舟', toName: '玄阳真人', relation: '师徒' });
  await seedCharacterState(request, book.id, { name: '陆沉舟', chapter: 1, category: 'possession', content: '持有半块染血令牌。' });
  return { env, bookId: book.id };
}

async function generate(env: ReturnType<typeof createTestApp>, bookId: number, idx = 1) {
  return env.request.post(`/api/books/${bookId}/chapters/${idx}/generate`);
}

async function pendingSuspensions(env: ReturnType<typeof createTestApp>, bookId: number) {
  const res = await env.request.get(`/api/books/${bookId}/suspensions?status=pending`);
  if (res.status !== 200) throw new Error(`获取挂起队列失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body.items as Record<string, unknown>[];
}

// ---------- verify：双报告 + 指标入库 ----------

it('commit 前自动出双报告，指标按章入库', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
  const { env, bookId } = await seedPipelineBook(llm);

  const res = await generate(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.run.status).toBe('done');
  expect(res.body.chapter.content).toBe(PASS_TEXT);

  // 双报告落在 run 上
  const detection = res.body.run.detectionReport;
  expect(detection.metrics).toHaveLength(8);
  expect(detection.wordCount).toBeGreaterThan(0);
  expect(typeof detection.adjustedScore).toBe('number');
  expect(res.body.run.semanticReport).toEqual({ conflicts: [] });

  // 语义核查走 verify 任务路由，prompt 对照正文与事实库
  const verifyCalls = llm.calls.filter((call) => call.task === 'verify');
  expect(verifyCalls).toHaveLength(1);
  const userMessage = verifyCalls[0]!.req.messages[1]!.content;
  expect(userMessage).toContain('金銮殿');
  expect(userMessage).toContain('师徒'); // 事实库内容进入核查上下文
  expect(userMessage).toContain('玄阳真人');

  // 指标入库：趋势接口可读
  const metrics = await env.request.get(`/api/books/${bookId}/metrics`);
  expect(metrics.status).toBe(200);
  expect(metrics.body.items).toHaveLength(1);
  expect(metrics.body.items[0]).toMatchObject({
    idx: 1,
    aiScore: detection.aiScore,
    confidence: detection.confidence,
    adjustedScore: detection.adjustedScore,
    wordCount: detection.wordCount,
  });
  expect(metrics.body.items[0].metrics).toHaveLength(8);
});

it('不达标触发定向重写：只动问题段落，其余句原样保留', async () => {
  const llm = new FakeLLM({
    respond: { verify: semanticResult([]) },
    respondSequence: { draft: [draftResult(FAIL_TEXT), draftResult(GOOD_SENTENCE)] },
  });
  const { env, bookId } = await seedPipelineBook(llm);

  const res = await generate(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.run).toMatchObject({ status: 'done', stage: 'done', fixRounds: 1 });
  // 终稿 = 坏句段被重写句替换，其余句子逐字保留
  expect(res.body.chapter.content).toBe(FIXED_TEXT);

  // draft 被调用两次：初稿 + 一轮定向重写；verify 重跑两次（修复后复检）
  const draftCalls = llm.calls.filter((call) => call.task === 'draft');
  expect(draftCalls).toHaveLength(2);
  expect(llm.calls.filter((call) => call.task === 'verify')).toHaveLength(2);

  // 重写 prompt 只带问题段落与上下文，不带全文
  const fixPrompt = draftCalls[1]!.req.messages[1]!.content;
  expect(fixPrompt).toContain(BAD_SENTENCE);
  expect(fixPrompt).toContain('复读'); // 问题维度说明
  expect(fixPrompt).toContain('夜风掠过城头'); // 上下文前文（文风保留）
  expect(fixPrompt).not.toContain('金銮殿'); // 远处无关内容不进重写 prompt
});

it('2 轮修复仍不达标：自动挂起并列出队列项', async () => {
  const badRewrite = draftResult(STILL_BAD_REWRITE);
  const llm = new FakeLLM({
    respond: { verify: semanticResult([]) },
    respondSequence: { draft: [draftResult(FAIL_TEXT), badRewrite, badRewrite] },
  });
  const { env, bookId } = await seedPipelineBook(llm);

  const res = await generate(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.run).toMatchObject({ status: 'suspended', stage: 'fix', fixRounds: 2 });
  expect(res.body.chapter).toBeNull(); // 未过闸门不 commit
  expect(llm.calls.filter((call) => call.task === 'draft')).toHaveLength(3);
  expect(llm.calls.filter((call) => call.task === 'verify')).toHaveLength(3);

  // 队列项：3-gram 维带句级证据
  const items = await pendingSuspensions(env, bookId);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ source: 'detection', status: 'pending', round: 2, resolution: null });
  expect(items[0].title).toContain('3-gram');
  expect(items[0].detail).toMatchObject({ metricKey: 'trigramRepetition' });
  expect((items[0].detail as { hits: number[] }).hits).toHaveLength(2);

  // 指标在挂起时也已入库（最后一份 verify 报告）
  const metrics = await env.request.get(`/api/books/${bookId}/metrics`);
  expect(metrics.body.items[0].adjustedScore).toBeGreaterThan(0);
});

it('挂起项一键忽略：人工裁决放行，自动 commit', async () => {
  const badRewrite = draftResult(STILL_BAD_REWRITE);
  const llm = new FakeLLM({
    respond: { verify: semanticResult([]) },
    respondSequence: { draft: [draftResult(FAIL_TEXT), badRewrite, badRewrite] },
  });
  const { env, bookId } = await seedPipelineBook(llm);
  await generate(env, bookId);
  const [item] = await pendingSuspensions(env, bookId);

  const res = await env.request.post(`/api/books/${bookId}/chapters/1/suspensions/${item.id}/resolve`, {
    resolution: 'ignore',
  });
  expect(res.status).toBe(200);
  expect(res.body.run).toMatchObject({ status: 'done', stage: 'done' });
  expect(res.body.chapter.content).toBe(FAIL_TEXT); // 以最后一次复检的草稿提交
  expect((await pendingSuspensions(env, bookId))).toHaveLength(0);

  const all = await env.request.get(`/api/books/${bookId}/suspensions`);
  expect(all.body.items[0]).toMatchObject({ status: 'resolved', resolution: 'ignore' });
});

it('挂起项一键重写：修复达标后自动 commit', async () => {
  const badRewrite = draftResult(STILL_BAD_REWRITE);
  const llm = new FakeLLM({
    respond: { verify: semanticResult([]) },
    respondSequence: {
      draft: [draftResult(FAIL_TEXT), badRewrite, badRewrite, draftResult(GOOD_SENTENCE)],
    },
  });
  const { env, bookId } = await seedPipelineBook(llm);
  await generate(env, bookId);
  const [rewriteItem] = await pendingSuspensions(env, bookId);

  const res = await env.request.post(`/api/books/${bookId}/chapters/1/suspensions/${rewriteItem.id}/rewrite`, {});
  expect(res.status).toBe(200);
  expect(res.body.run).toMatchObject({ status: 'done', stage: 'done', fixRounds: 3 });
  expect(res.body.chapter.content).toBe(FIXED_TEXT);
  expect((await pendingSuspensions(env, bookId))).toHaveLength(0);
  expect(llm.calls.filter((call) => call.task === 'verify')).toHaveLength(4); // 复检一次
});

// ---------- 语义冲突：对照事实库的核查闸门 ----------

it('语义冲突挂起管线，修事实裁决后自动提交', async () => {
  const llm = new FakeLLM({
    respond: {
      draft: draftResult(PASS_TEXT),
      verify: semanticResult([{ quote: SEM_QUOTE_OLD, explanation: '皇帝已被软禁，不可能当场赐袍', factHint: '皇帝被软禁' }]),
    },
  });
  const { env, bookId } = await seedPipelineBook(llm);

  const res = await generate(env, bookId);
  expect(res.status).toBe(200);
  // 检测达标但存在语义冲突 → 挂起等待人工裁决
  expect(res.body.run).toMatchObject({ status: 'suspended', stage: 'fix', fixRounds: 0 });
  const [item] = await pendingSuspensions(env, bookId);
  expect(item).toMatchObject({ source: 'semantic', status: 'pending' });
  expect(item.detail).toMatchObject({ quote: SEM_QUOTE_OLD, explanation: '皇帝已被软禁，不可能当场赐袍' });

  const resolve = await env.request.post(`/api/books/${bookId}/chapters/1/suspensions/${item.id}/resolve`, {
    resolution: 'fact',
  });
  expect(resolve.status).toBe(200);
  expect(resolve.body.run).toMatchObject({ status: 'done' });
  expect(resolve.body.chapter.content).toBe(PASS_TEXT);
});

it('语义冲突一键重写：改写冲突句后复检通过并自动提交', async () => {
  const llm = new FakeLLM({
    respond: {
      draft: draftResult(PASS_TEXT),
      verify: semanticResult([{ quote: SEM_QUOTE_OLD, explanation: '与事实库矛盾', factHint: '' }]),
    },
  });
  const { env, bookId } = await seedPipelineBook(llm);
  await generate(env, bookId);
  expect((await pendingSuspensions(env, bookId))).toHaveLength(1);

  // 重写冲突句
  const [item] = await pendingSuspensions(env, bookId);
  llm.script.respondSequence = { draft: [draftResult(SEM_QUOTE_NEW)] };
  const res = await env.request.post(`/api/books/${bookId}/chapters/1/suspensions/${item.id}/rewrite`, {});
  expect(res.status).toBe(200);
  expect(res.body.run).toMatchObject({ status: 'done' });
  expect(res.body.chapter.content).toBe(PASS_TEXT.replace(SEM_QUOTE_OLD, SEM_QUOTE_NEW));
  expect(llm.calls.filter((call) => call.task === 'verify')).toHaveLength(2);
});

// ---------- 断点续跑与失败处理 ----------

it('verify 双报告落盘后中断：重启直接进闸门，verify 不重跑', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
  const { env, bookId } = await seedPipelineBook(llm);
  const first = await generate(env, bookId);
  expect(first.status).toBe(200);
  expect(llm.calls.filter((call) => call.task === 'verify')).toHaveLength(1);

  // 模拟「双报告已落盘、commit 未执行」时进程被杀
  env.db
    .prepare("UPDATE pipeline_runs SET stage = 'fix', status = 'running' WHERE book_id = ? AND idx = ?")
    .run(bookId, 1);
  env.db.prepare('DELETE FROM chapters').run();

  const second = await generate(env, bookId);
  expect(second.status).toBe(200);
  expect(second.body.run.status).toBe('done');
  expect(second.body.chapter.content).toBe(PASS_TEXT);
  expect(llm.calls.filter((call) => call.task === 'verify')).toHaveLength(1); // verify 不重跑
});

it('verify 路由未配置：409 且落盘 failed，配置后续跑不重复 draft', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
  const { env, bookId } = await seedPipelineBook(llm, { configureVerify: false });

  const first = await generate(env, bookId);
  expect(first.status).toBe(409);
  expect(first.body.error).toContain('路由');
  const runRow = env.db
    .prepare('SELECT stage, status, draft_content FROM pipeline_runs WHERE book_id = ? AND idx = ?')
    .get(bookId, 1) as { stage: string; status: string; draft_content: string | null };
  expect(runRow).toMatchObject({ stage: 'verify', status: 'failed' });
  expect(runRow.draft_content).toBe(PASS_TEXT); // draft 产物已落盘

  await configureRoute(env.request, 'verify');
  const second = await generate(env, bookId);
  expect(second.status).toBe(200);
  expect(second.body.run.status).toBe('done');
  expect(llm.calls.filter((call) => call.task === 'draft')).toHaveLength(1); // draft 不重调
  expect(llm.calls.filter((call) => call.task === 'verify')).toHaveLength(1);
});

it('语义核查响应不合法：502 且落盘 failed', async () => {
  const llm = new FakeLLM({
    respond: { draft: draftResult(PASS_TEXT), verify: { content: '我觉得没问题', model: 'fake-verify' } },
  });
  const { env, bookId } = await seedPipelineBook(llm);

  const res = await generate(env, bookId);
  expect(res.status).toBe(502);
  expect(res.body.error).toContain('核查');
  const runRow = env.db
    .prepare('SELECT stage, status FROM pipeline_runs WHERE book_id = ? AND idx = ?')
    .get(bookId, 1) as { stage: string; status: string };
  expect(runRow).toMatchObject({ stage: 'verify', status: 'failed' });
});

// ---------- 指标趋势与编辑重算 ----------

it('跨章趋势：两章指标按章号升序返回', async () => {
  const llm = new FakeLLM({
    respond: { verify: semanticResult([]) },
    respondSequence: {
      draft: [draftResult(PASS_TEXT), draftResult(PASS_TEXT.replace('夜风掠过城头', '朔风撕过城头'))],
    },
  });
  const { env, bookId } = await seedPipelineBook(llm);
  await generate(env, bookId, 1);
  await generate(env, bookId, 2);

  const metrics = await env.request.get(`/api/books/${bookId}/metrics`);
  expect(metrics.status).toBe(200);
  expect(metrics.body.items.map((item: { idx: number }) => item.idx)).toEqual([1, 2]);
  expect(metrics.body.items[0].adjustedScore).toBe(0);
});

it('人工编辑正文后指标重算（纯检测，不调 LLM）', async () => {
  const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]) } });
  const { env, bookId } = await seedPipelineBook(llm);
  await generate(env, bookId);
  const before = llm.calls.length;

  const edited = await env.request.patch(`/api/books/${bookId}/chapters/1`, { content: FAIL_TEXT });
  expect(edited.status).toBe(200);

  const metrics = await env.request.get(`/api/books/${bookId}/metrics`);
  expect(metrics.body.items[0].wordCount).toBe(158); // FAIL_TEXT 的词元数
  expect(llm.calls.length).toBe(before); // 编辑重算不走 LLM
});
