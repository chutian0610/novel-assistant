import { expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import type { ChatResult } from '../src/llm/types';
import {
  draftResult,
  FAIL_TEXT,
  GOOD_SENTENCE,
  PASS_TEXT,
  SEM_QUOTE_OLD,
  semanticResult,
} from './text-fixtures';
import {
  configureRoute,
  createTestApp,
  seedBook,
  seedChapterOutline,
  seedRelation,
  seedVolume,
} from './helpers';

/** 把事实回灌结果包装成 FakeLLM 的脚本化响应 */
function extractResult(payload: unknown): ChatResult {
  return { content: JSON.stringify(payload), model: 'fake-extract' };
}

// 证据均为 PASS_TEXT 的真实子串（回灌会做原文子串校验）
const EXTRACT_PAYLOAD = {
  characterStates: [
    { name: '陆沉舟', category: 'injury', content: '恐惧像潮水一样漫过心头，但他稳住了。', evidence: '恐惧像潮水一样漫过心头' },
  ],
  relations: [
    { fromName: '陆沉舟', toName: '玄阳真人', relation: '旧部', evidence: '「传令下去' },
  ],
  timeline: [{ title: '夜战退敌', content: '守军击退城下敌军。', evidence: '帐帘掀开' }],
  foreshadows: [
    { title: '残玉中的低语', content: '残玉在战意最盛时发烫。', targetChapter: 12, evidence: '夜风掠过城头' },
  ],
};

async function seedExtractionBook(llm: FakeLLM) {
  const env = createTestApp(llm);
  const { request } = env;
  const book = await seedBook(request);
  const volume = await seedVolume(request, book.id);
  const outline = await seedChapterOutline(request, book.id, volume.id, { title: '第1章 夜战' });
  await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, { status: 'approved' });
  for (const task of ['draft', 'verify', 'extract'] as const) {
    await configureRoute(request, task);
  }
  return { env, bookId: book.id };
}

async function generate(env: ReturnType<typeof createTestApp>, bookId: number, idx = 1) {
  return env.request.post(`/api/books/${bookId}/chapters/${idx}/generate`);
}

function autoRowCounts(db: ReturnType<typeof createTestApp>['db']) {
  const rows: Record<string, number> = {};
  for (const table of ['character_states', 'character_relations', 'timeline_events', 'foreshadows']) {
    rows[table] = (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE origin = 'auto'`).get() as { count: number }).count;
  }
  return rows;
}

it('落稿后四表自动回灌，每条带来源章与原文证据', async () => {
  const llm = new FakeLLM({
    respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), extract: extractResult(EXTRACT_PAYLOAD) },
  });
  const { env, bookId } = await seedExtractionBook(llm);

  const res = await generate(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.run).toMatchObject({ status: 'done', extractError: null });

  // 回灌走 extract 任务路由，prompt 带正文与章号定位
  const extractCalls = llm.calls.filter((call) => call.task === 'extract');
  expect(extractCalls).toHaveLength(1);
  const userMessage = extractCalls[0]!.req.messages[1]!.content;
  expect(userMessage).toContain('第1章');
  expect(userMessage).toContain('金銮殿');

  // 角色运行时：来源章 + 证据
  const states = await env.request.get(`/api/books/${bookId}/facts/characters`);
  expect(states.body.items).toHaveLength(1);
  expect(states.body.items[0]).toMatchObject({
    name: '陆沉舟',
    category: 'injury',
    chapter: 1,
    content: '恐惧像潮水一样漫过心头，但他稳住了。',
    evidence: '恐惧像潮水一样漫过心头',
  });

  // 人物关系
  const relations = await env.request.get(`/api/books/${bookId}/facts/relations`);
  expect(relations.body.items[0]).toMatchObject({ fromName: '陆沉舟', relation: '旧部', chapter: 1 });

  // 时间轴
  const timeline = await env.request.get(`/api/books/${bookId}/facts/timeline`);
  expect(timeline.body.items[0]).toMatchObject({ title: '夜战退敌', chapter: 1 });

  // 新伏笔自动登记为 planted 并进账本
  const foreshadows = await env.request.get(`/api/books/${bookId}/facts/foreshadows`);
  expect(foreshadows.body.items[0]).toMatchObject({
    title: '残玉中的低语',
    status: 'planted',
    plantedChapter: 1,
    targetChapter: 12,
  });

  // 全部为自动来源
  expect(autoRowCounts(env.db)).toEqual({
    character_states: 1,
    character_relations: 1,
    timeline_events: 1,
    foreshadows: 1,
  });
});

it('回灌幂等：同章重复 commit 与手动重灌不产生重复事实，人工事实不受影响', async () => {
  const llm = new FakeLLM({
    respond: { verify: semanticResult([]), extract: extractResult(EXTRACT_PAYLOAD) },
    respondSequence: {
      draft: [draftResult(PASS_TEXT), draftResult(PASS_TEXT.replace('夜风掠过城头', '朔风撕过城头'))],
    },
  });
  const { env, bookId } = await seedExtractionBook(llm);

  // 人工事实（回灌不得触碰）
  await seedRelation(env.request, bookId, { fromName: '陆沉舟', toName: '玄阳真人', relation: '师徒' });

  await generate(env, bookId);
  expect(autoRowCounts(env.db)).toEqual({
    character_states: 1,
    character_relations: 1,
    timeline_events: 1,
    foreshadows: 1,
  });

  // 重新生成（同章二次 commit）→ 自动事实被整章替换，不重复
  const second = await generate(env, bookId);
  expect(second.status).toBe(200);
  expect(autoRowCounts(env.db)).toEqual({
    character_states: 1,
    character_relations: 1,
    timeline_events: 1,
    foreshadows: 1,
  });

  // 手动重灌两次 → 仍然稳定
  for (let i = 0; i < 2; i++) {
    const res = await env.request.post(`/api/books/${bookId}/chapters/1/extract`, {});
    expect(res.status).toBe(200);
    expect(res.body.run.extractError).toBeNull();
  }
  expect(autoRowCounts(env.db)).toEqual({
    character_states: 1,
    character_relations: 1,
    timeline_events: 1,
    foreshadows: 1,
  });

  // 人工事实未被回灌触碰
  const relations = await env.request.get(`/api/books/${bookId}/facts/relations`);
  expect(relations.body.items).toHaveLength(2); // 1 人工 + 1 自动
  const manual = relations.body.items.find((item: { chapter: number }) => item.chapter === 3);
  expect(manual).toMatchObject({ relation: '师徒' });
});

it('回灌失败落盘不阻塞提交，可经手动端点恢复', async () => {
  const llm = new FakeLLM({
    respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), extract: new Error('额度不足') },
  });
  const { env, bookId } = await seedExtractionBook(llm);

  const res = await generate(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.run).toMatchObject({ status: 'done' });
  expect(res.body.run.extractError).toContain('额度不足');
  expect(autoRowCounts(env.db)['character_states']).toBe(0); // 章节已提交，事实待补

  // 修复脚本后手动重灌
  llm.script.respond = {
    draft: draftResult(PASS_TEXT),
    verify: semanticResult([]),
    extract: extractResult(EXTRACT_PAYLOAD),
  };
  const retry = await env.request.post(`/api/books/${bookId}/chapters/1/extract`, {});
  expect(retry.status).toBe(200);
  expect(retry.body.run.extractError).toBeNull();
  expect(autoRowCounts(env.db)['character_states']).toBe(1);
});

it('手动重灌仅对已落稿章节开放', async () => {
  const llm = new FakeLLM({ respond: { extract: extractResult(EXTRACT_PAYLOAD) } });
  const { env, bookId } = await seedExtractionBook(llm);

  const missing = await env.request.post(`/api/books/${bookId}/chapters/1/extract`, {});
  expect(missing.status).toBe(404);
});

it('回灌解析容错：非法条目逐条丢弃，合法条目照常入库', async () => {
  const llm = new FakeLLM({
    respond: {
      draft: draftResult(PASS_TEXT),
      verify: semanticResult([]),
      extract: extractResult({
        characterStates: [
          { name: '陆沉舟', category: 'injury', content: '他压下了恐惧。', evidence: '他压下这股寒意' },
          { name: '陆沉舟', category: 'mood', content: '类别非法应被丢弃', evidence: '夜风掠过城头' },
          { name: '陆沉舟', category: 'realm', content: '缺证据应被丢弃' },
          { name: '陆沉舟', category: 'possession', content: '编造证据应被丢弃', evidence: '凭空捏造的原文片段' },
        ],
      }),
    },
  });
  const { env, bookId } = await seedExtractionBook(llm);

  const res = await generate(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.run.extractError).toBeNull();
  const states = await env.request.get(`/api/books/${bookId}/facts/characters`);
  expect(states.body.items).toHaveLength(1);
  expect(states.body.items[0].content).toBe('他压下了恐惧。');
});

it('证据必须是正文子串：编造证据的条目不入库', async () => {
  // 单独验证：上一用例的四条状态里，仅证据可溯源的一条入库（编造/缺证据/非法类别的三条被丢弃）
  const llm = new FakeLLM({
    respond: {
      draft: draftResult(PASS_TEXT),
      verify: semanticResult([]),
      extract: extractResult({
        characterStates: [
          { name: '陆沉舟', category: 'injury', content: '真证据', evidence: '恐惧像潮水一样漫过心头' },
          { name: '玄阳真人', category: 'other', content: '假证据', evidence: '这句话不在正文里' },
        ],
      }),
    },
  });
  const { env, bookId } = await seedExtractionBook(llm);

  const res = await generate(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.run.extractError).toBeNull();
  const states = await env.request.get(`/api/books/${bookId}/facts/characters`);
  expect(states.body.items).toHaveLength(1);
  expect(states.body.items[0]).toMatchObject({ name: '陆沉舟', content: '真证据' });
});

it('编辑正文清除本章回灌事实（旧稿证据失效），重灌后以新稿重建', async () => {
  const llm = new FakeLLM({
    respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), extract: extractResult(EXTRACT_PAYLOAD) },
  });
  const { env, bookId } = await seedExtractionBook(llm);
  await generate(env, bookId);
  expect(autoRowCounts(env.db)['character_states']).toBe(1);

  // 编辑正文：本章 auto 事实清除（证据不再指向被替换的文本），人工回灌入口可重建
  const edited = await env.request.patch(`/api/books/${bookId}/chapters/1`, { content: FAIL_TEXT });
  expect(edited.status).toBe(200);
  expect(autoRowCounts(env.db)['character_states']).toBe(0);

  const resync = await env.request.post(`/api/books/${bookId}/chapters/1/extract`, {});
  expect(resync.status).toBe(200);
  expect(resync.body.run.extractError).toBeNull();
  expect(autoRowCounts(env.db)['character_states']).toBe(1); // FAIL_TEXT 的恐惧句仍在，证据可溯源
});

it('回灌响应不是合法 JSON：落盘 extractError，章节不回滚', async () => {
  const llm = new FakeLLM({
    respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), extract: { content: '我也说不好', model: 'fake' } },
  });
  const { env, bookId } = await seedExtractionBook(llm);

  const res = await generate(env, bookId);
  expect(res.status).toBe(200);
  expect(res.body.run.status).toBe('done');
  expect(res.body.run.extractError).toContain('JSON');
  expect(res.body.chapter).not.toBeNull();
});

it('人造矛盾定位到段落：重写 prompt 带事实线索，复核通过后自动提交并回灌', async () => {
  const conflicts = [
    { quote: SEM_QUOTE_OLD, explanation: '皇帝已被软禁，不可能当场赐袍', factHint: '皇帝被软禁于偏殿' },
  ];
  const llm = new FakeLLM({
    respond: {
      draft: draftResult(PASS_TEXT),
      verify: semanticResult(conflicts),
      extract: extractResult(EXTRACT_PAYLOAD),
    },
  });
  const { env, bookId } = await seedExtractionBook(llm);
  await generate(env, bookId);
  const runRow = env.db
    .prepare('SELECT status FROM pipeline_runs WHERE book_id = ? AND idx = ?')
    .get(bookId, 1) as { status: string };
  expect(runRow.status).toBe('suspended');

  // 定向重写该矛盾段：prompt 带引文、矛盾说明与事实线索
  llm.script.respond = {
    draft: draftResult(GOOD_SENTENCE.replace('残阳如血', '宫灯次第熄灭')),
    verify: semanticResult([]),
    extract: extractResult(EXTRACT_PAYLOAD),
  };
  const [item] = (
    await env.request.get(`/api/books/${bookId}/suspensions?status=pending`)
  ).body.items;
  expect(item.detail.factHint).toBe('皇帝被软禁于偏殿');
  const rewrite = await env.request.post(`/api/books/${bookId}/chapters/1/suspensions/${item.id}/rewrite`, {});
  expect(rewrite.status).toBe(200);
  expect(rewrite.body.run).toMatchObject({ status: 'done' }); // 复核通过自动提交

  const draftCalls = llm.calls.filter((call) => call.task === 'draft');
  const fixPrompt = draftCalls[draftCalls.length - 1]!.req.messages[1]!.content;
  expect(fixPrompt).toContain(SEM_QUOTE_OLD);
  expect(fixPrompt).toContain('皇帝已被软禁');
  expect(fixPrompt).toContain('皇帝被软禁于偏殿');

  // 复核通过的终稿含重写段，且 commit 后事实回灌以终稿为输入
  expect(rewrite.body.chapter.content).toContain('宫灯次第熄灭');
  expect(llm.calls.filter((call) => call.task === 'extract')).toHaveLength(1);
  const extractUser = llm.calls.filter((call) => call.task === 'extract')[0]!.req.messages[1]!.content;
  expect(extractUser).toContain('宫灯次第熄灭');
});
