import { describe, expect, it } from 'vitest';
import { DEFAULT_DETECTOR_CONFIG, type DetectorConfig } from '../src/detectors/metrics';
import { createTestApp } from './helpers';

/** 样本文本：句长交错、含适量对白与情绪、无套话（足以全维度可测） */
const SAMPLE_TEXT =
  '去。他一路向北走了三百余里，途中风雪交加，粮袋早就空了，只能靠挖草根勉强糊口。' +
  '他说道：「今日必取你性命。」随后转身离去，头也不回地走进茫茫风雪之中，只留下一个孤独的背影。' +
  '听到这个消息，他先是错愕，随即压下心头的波动，面色如常地安排起明日的行程。' +
  '少年背着行囊翻过山岭，看见溪水绕过青石奔流向东，岸边的老农牵着黄牛缓缓踱步，远处的村落升起炊烟。' +
  '山连着水，水绕着山，云雾漫过山巅；忽然狂风大作！飞沙走石，天昏地暗，一瞬之后又归于死寂。谁在暗中窥伺？';

describe('T7 检测 API：分析', () => {
  it('POST /detectors/analyze 返回 8 维固定顺序报告与倾向分', async () => {
    const { request } = createTestApp();
    const res = await request.post('/api/detectors/analyze', { text: SAMPLE_TEXT });
    expect(res.status).toBe(200);

    const report = res.body as {
      sentences: string[];
      metrics: { key: string; value: number; threshold: unknown; pass: boolean; score: number; hits: number[] }[];
      aiScore: number;
      confidence: number;
      adjustedScore: number;
      wordCount: number;
      insufficient: boolean;
    };
    expect(report.metrics.map((metric) => metric.key)).toEqual([
      'trigramRepetition',
      'sentenceLengthCV',
      'lexicalDiversity',
      'templatePhrase',
      'punctuationCV',
      'dialogueRatio',
      'emotionDensity',
      'semanticSmoothness',
    ]);
    for (const metric of report.metrics) {
      expect(metric.score).toBeGreaterThanOrEqual(0);
      expect(metric.score).toBeLessThanOrEqual(1);
      expect(metric.threshold).toBeDefined();
      expect(Array.isArray(metric.hits)).toBe(true);
    }
    expect(report.sentences.length).toBeGreaterThan(3);
    expect(report.wordCount).toBeGreaterThan(60);
    expect(report.insufficient).toBe(false);
    expect(report.confidence).toBe(1);
    expect(report.aiScore).toBeGreaterThanOrEqual(0);
    expect(report.aiScore).toBeLessThanOrEqual(100);
    expect(report.adjustedScore).toBe(report.aiScore);
  });

  it('模板套话文本命中模板维度并定位句', async () => {
    const { request } = createTestApp();
    const res = await request.post('/api/detectors/analyze', {
      text: '众所周知，宗门大比三年一度。总而言之，这一战他不能输。综上所述，胜负手在于先手。值得注意的是，对面也不是善茬。'.repeat(3),
    });
    expect(res.status).toBe(200);
    const report = res.body as { metrics: { key: string; pass: boolean; hits: number[] }[] };
    const template = report.metrics.find((metric) => metric.key === 'templatePhrase')!;
    expect(template.pass).toBe(false);
    expect(template.hits.length).toBeGreaterThanOrEqual(4);
  });

  it('空文本/纯空白/超长文本 → 400', async () => {
    const { request } = createTestApp();
    expect((await request.post('/api/detectors/analyze', { text: '' })).status).toBe(400);
    expect((await request.post('/api/detectors/analyze', { text: '   \n  ' })).status).toBe(400);
    expect((await request.post('/api/detectors/analyze', {})).status).toBe(400);
    expect((await request.post('/api/detectors/analyze', { text: '好'.repeat(200_001) })).status).toBe(400);
  });
});

describe('T7 检测 API：阈值配置', () => {
  it('GET 返回默认阈值结构（11 个键，camelCase）', async () => {
    const { request } = createTestApp();
    const res = await request.get('/api/detectors/config');
    expect(res.status).toBe(200);
    const config = res.body as DetectorConfig;
    expect(config).toEqual(DEFAULT_DETECTOR_CONFIG);
  });

  it('PUT 收紧阈值后同一文本的问题分上升，且新值持久化', async () => {
    const { request } = createTestApp();
    // 词汇丰富的文本：默认阈值（0.55）下达标零分，收紧到 0.95 后不达标
    const sample =
      '少年背着行囊翻过山岭，看见溪水绕过青石奔流向东，岸边的老农牵着黄牛缓缓踱步，远处的村落升起炊烟，几只白鹭掠过稻田。' +
      '货郎摇着拨浪鼓沿街叫卖胭脂水粉，孩童追逐嬉闹，妇人倚门唤儿归家吃饭，铁匠铺里火星四溅锤声叮当，教书先生摇头晃脑诵着经义，酒肆中侠客痛饮烈酒拍案而起。';
    const lexicalScoreOf = async () => {
      const res = await request.post('/api/detectors/analyze', { text: sample });
      expect(res.status).toBe(200);
      return (res.body as { metrics: { key: string; score: number }[] }).metrics.find(
        (metric) => metric.key === 'lexicalDiversity'
      )!.score;
    };

    expect(await lexicalScoreOf()).toBe(0);
    const put = await request.put('/api/detectors/config', { lexicalDiversityThreshold: 0.95 });
    expect(put.status).toBe(200);
    expect((put.body as DetectorConfig).lexicalDiversityThreshold).toBe(0.95);
    expect(await lexicalScoreOf()).toBeGreaterThan(0);

    // 持久化：重读仍是新值（真实 SQLite 落盘）
    const got = await request.get('/api/detectors/config');
    expect((got.body as DetectorConfig).lexicalDiversityThreshold).toBe(0.95);
  });

  it('非法阈值（越界/类型错/区间倒置）→ 400', async () => {
    const { request } = createTestApp();
    expect((await request.put('/api/detectors/config', { lexicalDiversityThreshold: -0.1 })).status).toBe(400);
    expect((await request.put('/api/detectors/config', { lexicalDiversityThreshold: 1.5 })).status).toBe(400);
    expect((await request.put('/api/detectors/config', { lexicalDiversityThreshold: '高' })).status).toBe(400);
    expect((await request.put('/api/detectors/config', { unknownKey: 1 })).status).toBe(400);
    expect((await request.put('/api/detectors/config', {})).status).toBe(400);
    expect((await request.put('/api/detectors/config', { dialogueRatioMin: 0.9, dialogueRatioMax: 0.1 })).status).toBe(400);
    expect((await request.put('/api/detectors/config', { emotionDensityMin: 0.5, emotionDensityMax: 0.1 })).status).toBe(400);
  });
});
