import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../src/llm/fake';
import type { ChatResult } from '../src/llm/types';
import { RadarParseError, parseRadar } from '../src/radar/analyze';
import type { RadarResponse } from '../src/radar/store';
import { configureRoute, createTestApp, seedBook, seedChapterOutline, seedVolume, type TestEnv } from './helpers';
import { PASS_TEXT, draftResult, semanticResult } from './text-fixtures';

/** FakeLLM 的 analyze 脚本回包（任意 JSON 序列化为 content） */
function analyzeResult(payload: unknown): ChatResult {
  return { content: JSON.stringify(payload), model: 'fake' };
}

const GAIN_QUOTE = '皇帝在金銮殿上抚掌大笑，当场赐下蟒袍玉带。';
const HOOK_QUOTE = '盘算着下一场恶仗的走法，盘算着粮道，盘算着援兵。';

const THRILL_PAYLOAD = {
  thrills: [
    { type: 'gain', quote: GAIN_QUOTE, intensity: 4, reason: '御前赐赏' },
    { type: 'other', quote: '这句话不在正文里。', intensity: 2, reason: '编造的应被丢弃' },
  ],
  hook: { rating: 'strong', quote: HOOK_QUOTE, reason: '恶仗悬念' },
};

const EMPTY_PAYLOAD = { thrills: [], hook: { rating: 'weak', quote: '', reason: '平淡收尾' } };

/** 落稿前 N 章（章纲先批准；draft/verify/analyze 路由由 FakeLLM 脚本应答） */
async function commitChapters(request: TestEnv['request'], bookId: number, volumeId: number, count: number) {
  for (let idx = 1; idx <= count; idx++) {
    const outline = await seedChapterOutline(request, bookId, volumeId, { title: `第${idx}章 测试` });
    await request.post(`/api/books/${bookId}/outlines/chapters/${outline.id}/status`, { status: 'approved' });
  }
  for (const task of ['draft', 'verify', 'analyze'] as const) {
    await configureRoute(request, task);
  }
  for (let idx = 1; idx <= count; idx++) {
    const res = await request.post(`/api/books/${bookId}/chapters/${idx}/generate`, {});
    if (res.status !== 200) throw new Error(`生成第 ${idx} 章失败：${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function radarOf(request: TestEnv['request'], bookId: number): Promise<RadarResponse> {
  const res = await request.get(`/api/books/${bookId}/radar`);
  expect(res.status).toBe(200);
  return res.body as RadarResponse;
}

describe('parseRadar 解析（纯函数）', () => {
  it('类型/评级白名单外、强度越界、缺 quote 的条目逐条丢弃；围栏容忍', () => {
    const parsed = parseRadar(
      '```json\n' +
        JSON.stringify({
          thrills: [
            { type: 'gain', quote: '原句甲', intensity: 3, reason: '合理' },
            { type: 'hype', quote: '类型不在白名单', intensity: 3, reason: 'x' },
            { type: 'gain', quote: '  ', intensity: 3, reason: '缺quote' },
            { type: 'gain', quote: '强度为零', intensity: 0, reason: 'x' },
            { type: 'gain', quote: '强度越界', intensity: 6, reason: 'x' },
            { type: 'gain', quote: '强度非整数', intensity: 2.5, reason: 'x' },
          ],
          hook: { rating: 'huge', quote: '评级不在白名单', reason: 'x' },
        }) +
        '\n```'
    );
    expect(parsed.thrills).toHaveLength(1);
    expect(parsed.thrills[0]).toMatchObject({ type: 'gain', quote: '原句甲', intensity: 3, reason: '合理' });
    expect(parsed.hook).toBeNull();
  });

  it('hook 缺失 → null；thrills 非数组 → 空数组；非法 JSON 抛 RadarParseError', () => {
    const parsed = parseRadar(JSON.stringify({ thrills: '不是数组', hook: { rating: 'none', quote: '', reason: '' } }));
    expect(parsed.thrills).toEqual([]);
    expect(parsed.hook).toMatchObject({ rating: 'none' });
    expect(() => parseRadar('完全不是 JSON')).toThrow(RadarParseError);
  });
});

describe('T18 爽点雷达：落稿自动回灌', () => {
  it('generate 后自动评测：标注落库、span 定位、编造 quote 丢弃', async () => {
    const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), analyze: analyzeResult(THRILL_PAYLOAD) } });
    const { request } = createTestApp(llm);
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    await commitChapters(request, book.id, volume.id, 1);

    const radar = await radarOf(request, book.id);
    expect(radar.warning).toBeNull();
    expect(radar.items).toHaveLength(1);
    const chapter = radar.items[0]!;
    expect(chapter.idx).toBe(1);
    expect(chapter.thrillCount).toBe(1); // 编造 quote 的条目被证据校验丢弃
    expect(chapter.maxIntensity).toBe(4);
    expect(chapter.thrills[0]).toMatchObject({ type: 'gain', intensity: 4, origin: 'auto' });
    expect(chapter.thrills[0]!.spanStart).toBe(PASS_TEXT.indexOf(GAIN_QUOTE));
    expect(chapter.thrills[0]!.spanEnd).toBe((chapter.thrills[0]!.spanStart ?? 0) + GAIN_QUOTE.length);
    expect(chapter.hook).toMatchObject({ rating: 'strong', quote: HOOK_QUOTE });
    // 生成响应的 run 上雷达旁路无错误
    expect(llm.calls.filter((call) => call.task === 'analyze')).toHaveLength(1);
  });

  it('analyze 失败不阻塞提交：章节照常落稿，radar_error 落盘，手动重灌恢复', async () => {
    const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), analyze: new Error('评测宕机') } });
    const { request } = createTestApp(llm);
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    // 手动走一遍生成流以捕获 generate 响应中的 run
    const outline = await seedChapterOutline(request, book.id, volume.id, { title: '第1章 测试' });
    await request.post(`/api/books/${book.id}/outlines/chapters/${outline.id}/status`, { status: 'approved' });
    for (const task of ['draft', 'verify', 'analyze'] as const) await configureRoute(request, task);

    const genRes = await request.post(`/api/books/${book.id}/chapters/1/generate`, {});
    expect(genRes.status).toBe(200); // 评测失败不阻塞提交
    expect(genRes.body.chapter).toMatchObject({ idx: 1 });
    expect(genRes.body.run.radarError).toContain('爽点回灌失败：评测宕机');

    const radar = await radarOf(request, book.id);
    expect(radar.items).toHaveLength(0); // 评测失败无标注，但章节已落稿

    // 手动重灌恢复：脚本恢复后重灌成功，radar_error 清空
    llm.script.respond = { ...llm.script.respond, analyze: analyzeResult(THRILL_PAYLOAD) };
    const res = await request.post(`/api/books/${book.id}/chapters/1/radar`, {});
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.run.radarError).toBeNull();
    expect(res.body.radar).toMatchObject({ idx: 1, thrillCount: 1 });
    expect((await radarOf(request, book.id)).items[0]!.thrillCount).toBe(1);
  });

  it('手动重灌幂等：重复评测整章替换，不产生重复标注', async () => {
    const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), analyze: analyzeResult(THRILL_PAYLOAD) } });
    const { request } = createTestApp(llm);
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    await commitChapters(request, book.id, volume.id, 1);

    await request.post(`/api/books/${book.id}/chapters/1/radar`, {});
    await request.post(`/api/books/${book.id}/chapters/1/radar`, {});
    const chapter = (await radarOf(request, book.id)).items[0]!;
    expect(chapter.thrillCount).toBe(1);
    expect(chapter.thrills[0]!.origin).toBe('auto');
  });

  it('未落稿章手动重灌 404；空书雷达为空且无预警', async () => {
    const { request } = createTestApp();
    const book = await seedBook(request);
    expect((await request.post(`/api/books/${book.id}/chapters/1/radar`, {})).status).toBe(404);
    const radar = await radarOf(request, book.id);
    expect(radar.items).toEqual([]);
    expect(radar.warning).toBeNull();
  });
});

describe('T18 爽点雷达：连续压抑预警', () => {
  it('连续 N 章无爽点触发预警；窗口可配；有爽点的章打断压抑链', async () => {
    const llm = new FakeLLM({ respond: { draft: draftResult(PASS_TEXT), verify: semanticResult([]), analyze: analyzeResult(EMPTY_PAYLOAD) } });
    const { request } = createTestApp(llm);
    const book = await seedBook(request);
    const volume = await seedVolume(request, book.id);
    await commitChapters(request, book.id, volume.id, 3);

    // 三连零爽点，默认窗口 3 → 预警
    const warned = await radarOf(request, book.id);
    expect(warned.warning).toMatchObject({ streak: 3, window: 3, fromIdx: 1, toIdx: 3 });

    // 窗口调大到 4 → 不预警
    await request.put('/api/settings/pipeline', { radarDepressionWindow: 4 });
    expect((await radarOf(request, book.id)).warning).toBeNull();
    await request.put('/api/settings/pipeline', { radarDepressionWindow: 3 });

    // 第 2 章重灌出爽点 → 压抑链断（第 3 章零爽点 streak=1 < 3）
    llm.script.respond = { ...llm.script.respond, analyze: analyzeResult(THRILL_PAYLOAD) };
    await request.post(`/api/books/${book.id}/chapters/2/radar`, {});
    expect((await radarOf(request, book.id)).warning).toBeNull();
    const items = (await radarOf(request, book.id)).items;
    expect(items.find((item) => item.idx === 2)!.thrillCount).toBe(1);
    expect(items.find((item) => item.idx === 3)!.thrillCount).toBe(0);
  });
});
