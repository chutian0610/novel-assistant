import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DETECTOR_CONFIG,
  METRIC_KEYS,
  METRIC_WEIGHTS,
  MIN_SAMPLE_WORDS,
  analyzeText,
  computeAiScore,
  scoreAboveLimit,
  scoreBelowLimit,
  scoreOutsideRange,
  splitSentences,
  type MetricKey,
} from '../src/detectors/metrics';

/** 按维度 key 取指标结果 */
function metricOf(key: MetricKey) {
  return (report: ReturnType<typeof analyzeText>) => {
    const metric = report.metrics.find((candidate) => candidate.key === key);
    if (!metric) throw new Error(`缺少指标 ${key}`);
    return metric;
  };
}

describe('T7 检测器：切句', () => {
  it('按中文终止标点/省略号/换行切句，保留标点，滤掉空句', () => {
    const sentences = splitSentences('天地一线。他来了！真的吗？好吧；随他……\n次日清晨。');
    expect(sentences).toEqual(['天地一线。', '他来了！', '真的吗？', '好吧；', '随他……', '次日清晨。']);
  });
});

describe('T7 检测器：8 维指标对构造文本的方向断言', () => {
  const lexical = metricOf('lexicalDiversity');
  const sentenceCV = metricOf('sentenceLengthCV');
  const trigram = metricOf('trigramRepetition');
  const template = metricOf('templatePhrase');
  const punctuation = metricOf('punctuationCV');
  const dialogue = metricOf('dialogueRatio');
  const emotion = metricOf('emotionDensity');
  const semantic = metricOf('semanticSmoothness');

  it('词汇多样性：复读文本不达标，词汇丰富的文本达标', () => {
    const repetitive = analyzeText(
      '他看见山。他看见水。他看见树。他看见路。他看见云。他看见风。他看见雨。他看见雪。他看见火。他看见光。'.repeat(3),
      DEFAULT_DETECTOR_CONFIG
    );
    const rich = analyzeText(
      '少年背着行囊翻过山岭，看见溪水绕过青石奔流向东，岸边的老农牵着黄牛缓缓踱步，远处的村落升起炊烟，几只白鹭掠过稻田。' +
        '货郎摇着拨浪鼓沿街叫卖胭脂水粉，孩童追逐嬉闹，妇人倚门唤儿归家吃饭，铁匠铺里火星四溅锤声叮当，教书先生摇头晃脑诵着经义，酒肆中侠客痛饮烈酒拍案而起。',
      DEFAULT_DETECTOR_CONFIG
    );
    expect(lexical(repetitive).pass).toBe(false);
    expect(lexical(repetitive).score).toBeGreaterThan(0);
    expect(rich.metrics.length).toBe(8);
    expect(lexical(rich).pass).toBe(true);
    expect(lexical(rich).score).toBe(0);
  });

  it('句长波动：等长句 CV 不达标，长短交错达标', () => {
    const uniform = analyzeText('他往北走。他往南走。他往东走。他往西走。他往天上走。他往海里走。'.repeat(3), DEFAULT_DETECTOR_CONFIG);
    const varied = analyzeText(
      '去。他一路向北走了三百余里，途中风雪交加，粮袋早就空了，只能靠挖草根勉强糊口，好歹撑到了关外。' +
        '住。'.repeat(3),
      DEFAULT_DETECTOR_CONFIG
    );
    expect(sentenceCV(uniform).value).toBeLessThan(0.2);
    expect(sentenceCV(uniform).pass).toBe(false);
    expect(sentenceCV(varied).pass).toBe(true);
  });

  it('3-gram 重复：无重复为零分，同句口头禅式复读超阈值并定位句', () => {
    const clean = analyzeText(
      '少年背着行囊翻过山岭，看见溪水绕过青石奔流向东。岸边的老农牵着黄牛缓缓踱步，远处的村落升起炊烟。'.repeat(2),
      DEFAULT_DETECTOR_CONFIG
    );
    const withRepeat = analyzeText(
      '他一刀劈开山岳，又一刀劈开山岳，再一刀劈开山岳，刀刀都劈开山岳，气势汹汹。围观众人目瞪口呆，久久说不出话来，半晌才回过神。'.repeat(2),
      DEFAULT_DETECTOR_CONFIG
    );
    expect(trigram(clean).value).toBe(0);
    expect(trigram(clean).pass).toBe(true);
    expect(trigram(withRepeat).value).toBeGreaterThan(DEFAULT_DETECTOR_CONFIG.trigramRepetitionThreshold);
    expect(trigram(withRepeat).pass).toBe(false);
    expect(trigram(withRepeat).hits.length).toBeGreaterThanOrEqual(2);
  });

  it('模板套话：干净文本零命中，套话密集文本超阈值并定位句', () => {
    const clean = analyzeText(
      '少年背着行囊翻过山岭，看见溪水绕过青石奔流向东。岸边的老农牵着黄牛缓缓踱步，远处的村落升起炊烟，几只白鹭掠过稻田。'.repeat(3),
      DEFAULT_DETECTOR_CONFIG
    );
    const templated = analyzeText(
      '众所周知，宗门大比三年一度。总而言之，这一战他不能输。综上所述，胜负手在于先手。值得注意的是，对面也不是善茬。'.repeat(3),
      DEFAULT_DETECTOR_CONFIG
    );
    expect(template(clean).value).toBe(0);
    expect(template(clean).pass).toBe(true);
    expect(template(templated).value).toBeGreaterThan(DEFAULT_DETECTOR_CONFIG.templatePhrasePerKiloWordThreshold);
    expect(template(templated).pass).toBe(false);
    expect(template(templated).hits.length).toBeGreaterThanOrEqual(4);
  });

  it('标点节奏：等间隔标点 CV 过低不达标，长短交错达标', () => {
    const uniform = analyzeText('山。水。天。地。花。草。云。风。雨。雪。霜。露。'.repeat(2), DEFAULT_DETECTOR_CONFIG);
    const varied = analyzeText(
      '山连着水，水绕着山，云雾漫过山巅；忽然狂风大作！飞沙走石，天昏地暗，一瞬之后天地间又归于令人窒息的死寂。谁在暗中窥伺？没人知道。'.repeat(2),
      DEFAULT_DETECTOR_CONFIG
    );
    expect(punctuation(uniform).pass).toBe(false);
    expect(punctuation(varied).pass).toBe(true);
  });

  it('对白比例：无对白低于下限，全对白超上限，适量达标并标出对白句', () => {
    const none = analyzeText(
      '少年背着行囊翻过山岭，看见溪水绕过青石奔流向东。岸边的老农牵着黄牛缓缓踱步，远处的村落升起炊烟，几只白鹭掠过稻田。'.repeat(3),
      DEFAULT_DETECTOR_CONFIG
    );
    const allDialogue = analyzeText(
      '「今日之事已无可挽回，你走罢，走得越远越好，莫要回头。」「我不走，就算死，我也要死在这里。」'.repeat(3),
      DEFAULT_DETECTOR_CONFIG
    );
    const moderate = analyzeText(
      '他说道：「今日必取你性命。」随后转身离去，头也不回地走进茫茫风雪之中，只留下一个孤独的背影，和一串很快被大雪掩埋的脚印。'.repeat(2),
      DEFAULT_DETECTOR_CONFIG
    );
    expect(dialogue(none).pass).toBe(false);
    expect(dialogue(none).score).toBeGreaterThan(0);
    expect(dialogue(allDialogue).pass).toBe(false);
    expect(dialogue(moderate).pass).toBe(true);
    expect(dialogue(moderate).hits.length).toBe(2);
  });

  it('情绪密度：无情绪低于下限，堆情绪超上限并定位句，适量达标', () => {
    const none = analyzeText(
      '少年背着行囊翻过山岭，看见溪水绕过青石奔流向东。岸边的老农牵着黄牛缓缓踱步，远处的村落升起炊烟，几只白鹭掠过稻田。'.repeat(3),
      DEFAULT_DETECTOR_CONFIG
    );
    const flooded = analyzeText(
      '他震惊，他愤怒，他恐惧，他绝望，他悲伤，他狂喜，他错愕，他懊悔，他愤恨，他惊骇。'.repeat(3),
      DEFAULT_DETECTOR_CONFIG
    );
    const moderate = analyzeText(
      '听到这个消息，他先是错愕，随即压下心头的波动，面色如常地安排起明日的行程，仿佛什么都没有发生，转身吩咐下人备马，又提笔把没写完的信写完。'.repeat(2),
      DEFAULT_DETECTOR_CONFIG
    );
    expect(emotion(none).pass).toBe(false);
    expect(emotion(flooded).pass).toBe(false);
    expect(emotion(flooded).hits.length).toBeGreaterThanOrEqual(3);
    expect(emotion(moderate).pass).toBe(true);
  });

  it('语义平滑：句句近似衔接过于均匀不达标，话题跳变（承接有起伏）达标', () => {
    const smooth = analyzeText(
      '他走进院子看花。他走进院子赏花。他走进院子浇花。他走进院子闻花。他走进院子画画。'.repeat(2),
      DEFAULT_DETECTOR_CONFIG
    );
    const jumpy = analyzeText(
      '他走进院子看花。花圃里蜜蜂嗡嗡作响。关外的战报连夜送进了帅帐。军师把地图铺开在案上。地图边缘的朱批已经褪色。'.repeat(2),
      DEFAULT_DETECTOR_CONFIG
    );
    expect(semantic(smooth).pass).toBe(false);
    expect(semantic(jumpy).pass).toBe(true);
  });
});

describe('T7 检测器：加权倾向分与权重序', () => {
  it('权重序符合 spec：重复>句长>词汇>模板>标点>对白>情绪>语义，且权重和为 1', () => {
    const weights = METRIC_KEYS.map((key) => METRIC_WEIGHTS[key]);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 10);
  });

  it('合成公式：全零为零分，全满为百分，单维拉满贡献 = 权重×100', () => {
    const zero = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0])) as Record<MetricKey, number>;
    const full = Object.fromEntries(METRIC_KEYS.map((key) => [key, 1])) as Record<MetricKey, number>;
    expect(computeAiScore(zero)).toBe(0);
    expect(computeAiScore(full)).toBeCloseTo(100, 9);
    for (const key of METRIC_KEYS) {
      const only = { ...zero, [key]: 1 };
      expect(computeAiScore(only)).toBeCloseTo(METRIC_WEIGHTS[key] * 100, 9);
    }
  });

  it('重复问题的贡献严格大于句长问题（同分数下权重序生效）', () => {
    const zero = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0])) as Record<MetricKey, number>;
    expect(computeAiScore({ ...zero, trigramRepetition: 0.5 })).toBeGreaterThan(
      computeAiScore({ ...zero, sentenceLengthCV: 0.5 })
    );
  });
});

describe('T7 检测器：分数归一化边界', () => {
  it('上限型：阈值处零分，2 倍阈值处饱和 1 分', () => {
    expect(scoreAboveLimit(0.02, 0.02)).toBe(0);
    expect(scoreAboveLimit(0.03, 0.02)).toBeCloseTo(0.5, 9);
    expect(scoreAboveLimit(0.05, 0.02)).toBe(1);
    expect(scoreAboveLimit(1, 0)).toBe(1);
  });

  it('下限型：阈值处零分，零值饱和 1 分；无下限恒零分', () => {
    expect(scoreBelowLimit(0.55, 0.55)).toBe(0);
    expect(scoreBelowLimit(0.275, 0.55)).toBeCloseTo(0.5, 9);
    expect(scoreBelowLimit(0, 0.55)).toBe(1);
    expect(scoreBelowLimit(0.5, 0)).toBe(0);
  });

  it('区间型：区间内零分，端点外线性恶化直至饱和', () => {
    expect(scoreOutsideRange(0.45, 0.3, 0.65)).toBe(0);
    expect(scoreOutsideRange(0.15, 0.3, 0.65)).toBeCloseTo(0.5, 9);
    expect(scoreOutsideRange(0, 0.3, 0.65)).toBe(1);
    expect(scoreOutsideRange(1.3, 0.3, 0.65)).toBe(1);
    expect(scoreOutsideRange(0.9, 0.3, 0.65)).toBeCloseTo((0.9 - 0.65) / 0.65, 9);
  });
});

describe('T7 检测器：短文本降权', () => {
  it('词元数不足最低样本时按比例降权并标记样本不足', () => {
    const tiny = analyzeText('他去山下买了些米面粮油，顺便打了一壶浊酒。', DEFAULT_DETECTOR_CONFIG);
    expect(tiny.insufficient).toBe(true);
    expect(tiny.confidence).toBeCloseTo(tiny.wordCount / MIN_SAMPLE_WORDS, 9);
    expect(tiny.adjustedScore).toBeLessThanOrEqual(tiny.aiScore);
    expect(tiny.adjustedScore).toBeCloseTo(tiny.aiScore * tiny.confidence, 1);
  });

  it('样本充足时置信度为 1，降权后分数不变', () => {
    const enough = analyzeText(
      '少年背着行囊翻过山岭，看见溪水绕过青石奔流向东，岸边的老农牵着黄牛缓缓踱步，远处的村落升起炊烟，' +
        '几只白鹭掠过稻田，货郎摇着拨浪鼓沿街叫卖，孩童追逐嬉闹，妇人倚门唤儿归家，铁匠铺里锤声叮当。'.repeat(2),
      DEFAULT_DETECTOR_CONFIG
    );
    expect(enough.insufficient).toBe(false);
    expect(enough.confidence).toBe(1);
    expect(enough.adjustedScore).toBe(enough.aiScore);
  });

  it('空文本不抛错：全零报告、置信度为零', () => {
    const empty = analyzeText('', DEFAULT_DETECTOR_CONFIG);
    expect(empty.aiScore).toBe(0);
    expect(empty.confidence).toBe(0);
    expect(empty.adjustedScore).toBe(0);
    expect(empty.insufficient).toBe(true);
    expect(empty.sentences).toEqual([]);
  });
});
