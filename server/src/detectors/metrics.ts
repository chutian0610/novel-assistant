import { wordTokens } from '../lang/segment';

/**
 * 8 维确定性检测器（T7，spec：纯代码指标器，不经 LLM；统计指标全部为确定性纯函数）。
 *
 * 每维输出归一化问题分 score ∈ [0,1]（0 = 无问题，1 = 严重机器味）：
 * - 上限型（越高越差）：v ≤ 阈值 → 0；v > 阈值 → clamp((v - 阈值) / 阈值, 0, 1)
 * - 下限型（越低越差）：v ≥ 阈值 → 0；v < 阈值 → clamp((阈值 - v) / 阈值, 0, 1)
 * - 区间型（偏低/偏高都差）：低于 min → (min - v) / min；高于 max → (v - max) / max
 *
 * 维度口径：
 * 1. trigramRepetition   句内 3-gram 重复率——抓「口头禅式复读」（同一句内同一 3-gram 出现多次）；
 *                        跨句的句式复现是正常行文，不计
 * 2. sentenceLengthCV    句长（词元数）变异系数——机器句长均匀，人类长短交错
 * 3. lexicalDiversity    MATTR（滑动窗口 100 词元的平均 TTR）——比全文 TTR 抗长度干扰
 * 4. templatePhrase      模板套话每千词命中数——内置固定短语表逐字匹配（AI 套话 + 网文模板句式）
 * 5. punctuationCV       标点间隔（相邻标点事件间非标点字符数，连续标点合一次事件）变异系数
 * 6. dialogueRatio       对白字符数 / 非空白总字符数（一层引号内内容）
 * 7. emotionDensity      情绪词命中数 / 词元数——内置固定情绪词表
 * 8. semanticSmoothness  相邻句内容词元（≥2 字）Jaccard 重叠率序列的 CV——衔接过于均匀即机器味；
 *                        主题跳变的正常行文 CV 高
 *
 * 问题句定位（hits）：仅给出有句级证据的维度——trigram/template/emotion/dialogue；
 * 句长/词汇/标点/语义是全文级统计，不定位。
 *
 * 短文本降权：词元数不足 MIN_SAMPLE_WORDS 时统计不可靠，confidence = 词元数/最低样本，
 * adjustedScore = aiScore × confidence（报告同时带 insufficient 标记）。
 */

export const METRIC_KEYS = [
  'trigramRepetition',
  'sentenceLengthCV',
  'lexicalDiversity',
  'templatePhrase',
  'punctuationCV',
  'dialogueRatio',
  'emotionDensity',
  'semanticSmoothness',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

/**
 * 加权权重，固化于代码（spec 验收：权重序 重复>句长>词汇>模板>标点>对白>情绪>语义）。
 * 阈值可配置（detector_configs），权重不开放配置。
 */
export const METRIC_WEIGHTS: Record<MetricKey, number> = {
  trigramRepetition: 0.25,
  sentenceLengthCV: 0.2,
  lexicalDiversity: 0.15,
  templatePhrase: 0.12,
  punctuationCV: 0.1,
  dialogueRatio: 0.08,
  emotionDensity: 0.06,
  semanticSmoothness: 0.04,
};

/** 短文本降权的最低样本词元数 */
export const MIN_SAMPLE_WORDS = 60;

export interface DetectorConfig {
  /** 词汇多样性（MATTR）下限 */
  lexicalDiversityThreshold: number;
  /** 句长变异系数下限 */
  sentenceLengthCVThreshold: number;
  /** 3-gram 句内重复率上限 */
  trigramRepetitionThreshold: number;
  /** 模板套话每千词命中数上限 */
  templatePhrasePerKiloWordThreshold: number;
  /** 标点节奏变异系数自然区间 */
  punctuationCVMin: number;
  punctuationCVMax: number;
  /** 对白比例自然区间 */
  dialogueRatioMin: number;
  dialogueRatioMax: number;
  /** 情绪密度自然区间（情绪词数/词元数） */
  emotionDensityMin: number;
  emotionDensityMax: number;
  /** 语义平滑（相邻句重叠率 CV）下限 */
  semanticSmoothnessCVThreshold: number;
}

/** 阈值初始值（spec Further Notes 的自然区间外推；全部可在设置中修改） */
export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  lexicalDiversityThreshold: 0.55,
  sentenceLengthCVThreshold: 0.35,
  trigramRepetitionThreshold: 0.02,
  templatePhrasePerKiloWordThreshold: 2,
  punctuationCVMin: 0.3,
  punctuationCVMax: 0.65,
  dialogueRatioMin: 0.05,
  dialogueRatioMax: 0.65,
  emotionDensityMin: 0.003,
  emotionDensityMax: 0.06,
  semanticSmoothnessCVThreshold: 0.3,
};

export type MetricThreshold = number | { min: number; max: number };

export interface MetricResult {
  key: MetricKey;
  /** 原始指标值 */
  value: number;
  threshold: MetricThreshold;
  pass: boolean;
  /** 归一化问题分 0~1 */
  score: number;
  /** 问题/证据句索引（句级证据维度才有） */
  hits: number[];
  /** 样本不足无法计算（如句子太少），不计入评分 */
  skipped?: boolean;
}

export interface DetectionReport {
  sentences: string[];
  /** 固定按 METRIC_KEYS 顺序的 8 维结果 */
  metrics: MetricResult[];
  /** 加权 AI 倾向分 0~100（未降权） */
  aiScore: number;
  /** 短文本降权系数 0~1（1 = 样本充足） */
  confidence: number;
  /** aiScore × confidence */
  adjustedScore: number;
  wordCount: number;
  /** 词元数不足最低样本 */
  insufficient: boolean;
}

// ---------- 内置词表（V1 固定；逐字匹配，不受分词影响） ----------

/** 模板套话：AI 高频套话 + 网文模板句式 */
const TEMPLATE_PHRASES: readonly string[] = [
  '总而言之',
  '综上所述',
  '由此可见',
  '值得注意的是',
  '不难发现',
  '众所周知',
  '毫无疑问',
  '不可否认',
  '在很大程度上',
  '与此同时',
  '首先',
  '其次',
  '眼中闪过一丝',
  '嘴角勾起一抹',
  '心中一凛',
  '倒吸一口凉气',
  '空气仿佛凝固',
  '时间仿佛静止',
  '眸中精光一闪',
  '话音刚落',
  '只见',
  '打量了一番',
  '沉吟片刻',
  '面色一变',
];

/** 情绪词：喜怒哀惧惊等的双字词 */
const EMOTION_WORDS: readonly string[] = [
  '愤怒', '暴怒', '狂怒', '恼怒', '愤恨', '怨恨', '憎恨', '恐惧', '惊恐', '恐慌',
  '害怕', '畏惧', '悚然', '骇然', '惊骇', '震惊', '惊愕', '错愕', '诧异', '惊讶',
  '欣喜', '狂喜', '大喜', '欢喜', '喜悦', '愉悦', '兴奋', '激动', '悲伤', '悲痛',
  '悲哀', '哀伤', '忧伤', '绝望', '沮丧', '失落', '苦涩', '心酸', '紧张', '焦虑',
  '不安', '忐忑', '慌乱', '惊慌', '懊悔', '悔恨', '内疚', '愧疚', '羞愧', '尴尬',
  '嫉妒', '羡慕', '轻蔑', '鄙视', '厌恶', '不屑', '无奈', '茫然', '骇人', '悚惧',
];

/** 句终止标点（省略号整体算一次终止） */
const SENTENCE_ENDS = '。！？；?!;\n';

/** 中文/常用西文标点（标点节奏的采样点） */
const PUNCTUATION = new Set('。，、；：？！…—―~·,.:;?!()[]{}「」『』“”‘’〈〉《》【】+-*/=<>"\'');

const OPEN_QUOTES: Record<string, string> = { '「': '」', '『': '』', '“': '”', '‘': '’' };

// ---------- 基础纯函数 ----------

/** 按中文终止标点/省略号/换行切句，保留标点，滤掉空白句 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = '';
  let inEllipsis = false;
  for (const ch of text) {
    current += ch;
    if (ch === '…') {
      inEllipsis = true;
      continue;
    }
    if (inEllipsis) {
      pushSentence(sentences, current);
      current = '';
      inEllipsis = false;
      continue;
    }
    if (SENTENCE_ENDS.includes(ch)) {
      pushSentence(sentences, current);
      current = '';
    }
  }
  pushSentence(sentences, current);
  return sentences;
}

function pushSentence(sentences: string[], raw: string): void {
  const trimmed = raw.trim();
  if (trimmed !== '') sentences.push(trimmed);
}

/** 变异系数 = 标准差 / 均值；均值为 0 时定义为 0 */
function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * MATTR：滑动窗口 TTR 的均值（窗口 100 词元，步长 1）；不足一个窗口时退化为全文 TTR。
 * 比全文 TTR 抗文本长度干扰（TTR 随长度单调下降）。
 */
function movingAverageTypeTokenRatio(tokens: string[], window = 100): number {
  if (tokens.length === 0) return 0;
  if (tokens.length <= window) return new Set(tokens).size / tokens.length;
  const counts = new Map<string, number>();
  let distinct = 0;
  let sum = 0;
  let windows = 0;
  for (let i = 0; i < tokens.length; i++) {
    const incoming = tokens[i]!;
    const before = counts.get(incoming) ?? 0;
    counts.set(incoming, before + 1);
    if (before === 0) distinct += 1;
    if (i >= window) {
      const outgoing = tokens[i - window]!;
      const after = (counts.get(outgoing) ?? 1) - 1;
      if (after <= 0) {
        counts.delete(outgoing);
        distinct -= 1;
      } else {
        counts.set(outgoing, after);
      }
    }
    if (i >= window - 1) {
      sum += distinct / window;
      windows += 1;
    }
  }
  return windows === 0 ? 0 : sum / windows;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** 上限型分数：v ≤ 阈值为 0，阈值 2 倍处饱和为 1 */
export function scoreAboveLimit(value: number, limit: number): number {
  if (limit <= 0) return value > 0 ? 1 : 0;
  return clamp01((value - limit) / limit);
}

/** 下限型分数：v ≥ 阈值为 0，v = 0 时饱和为 1 */
export function scoreBelowLimit(value: number, limit: number): number {
  if (limit <= 0) return 0;
  return clamp01((limit - value) / limit);
}

/** 区间型分数：区间内为 0，两侧线性恶化（各自以端点距离归一） */
export function scoreOutsideRange(value: number, min: number, max: number): number {
  if (value < min) return scoreBelowLimit(value, min);
  if (value > max) return clamp01((value - max) / max);
  return 0;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

// ---------- 加权合成 ----------

/** 加权合成 AI 倾向分（0~100）：Σ 权重 × 维度分，权重序见 METRIC_WEIGHTS。返回精确值，展示层再舍入 */
export function computeAiScore(scores: Record<MetricKey, number>): number {
  return METRIC_KEYS.reduce((sum, key) => sum + METRIC_WEIGHTS[key] * scores[key], 0) * 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------- 主入口 ----------

/** 对文本做 8 维检测并合成倾向分。纯函数：空文本返回全零报告，不抛错 */
export function analyzeText(text: string, config: DetectorConfig): DetectionReport {
  const sentences = splitSentences(text);
  const tokens = wordTokens(text);
  const wordCount = tokens.length;

  const metrics = [
    detectTrigram(sentences, config),
    detectSentenceLengthCV(sentences, config),
    detectLexicalDiversity(tokens, config),
    detectTemplatePhrase(sentences, wordCount, config),
    detectPunctuationCV(text, config),
    detectDialogueRatio(sentences, config),
    detectEmotionDensity(sentences, wordCount, config),
    detectSemanticSmoothness(sentences, config),
  ];

  const scores = Object.fromEntries(metrics.map((metric) => [metric.key, metric.score])) as Record<MetricKey, number>;
  const rawAiScore = computeAiScore(scores);
  const confidence = clamp01(wordCount / MIN_SAMPLE_WORDS);
  return {
    sentences,
    metrics,
    aiScore: round1(rawAiScore),
    confidence,
    adjustedScore: round1(rawAiScore * confidence),
    wordCount,
    insufficient: wordCount < MIN_SAMPLE_WORDS,
  };
}

// ---------- 8 维指标器 ----------

/** 指标结果缺省形态：达标、零分、无定位；各维度器在其上覆写 */
function baseResult(key: MetricKey, threshold: MetricThreshold): MetricResult {
  return { key, value: 0, threshold, pass: true, score: 0, hits: [] };
}

function detectTrigram(sentences: string[], config: DetectorConfig): MetricResult {
  const threshold = config.trigramRepetitionThreshold;
  const base = baseResult('trigramRepetition', threshold);
  const hits = new Set<number>();
  let total = 0;
  let repeated = 0;
  sentences.forEach((sentence, index) => {
    const tokens = wordTokens(sentence);
    const counts = new Map<string, number>();
    for (let i = 0; i + 3 <= tokens.length; i++) {
      const gram = tokens.slice(i, i + 3).join('\u0000');
      const count = (counts.get(gram) ?? 0) + 1;
      counts.set(gram, count);
      if (count === 2) hits.add(index); // 同句内第二次出现才算口头禅式复读
      total += 1;
      if (count >= 2) repeated += 1;
    }
  });
  if (total === 0) return base;
  const value = repeated / total;
  return { ...base, value, pass: value <= threshold, score: scoreAboveLimit(value, threshold), hits: [...hits].sort((a, b) => a - b) };
}

function detectSentenceLengthCV(sentences: string[], config: DetectorConfig): MetricResult {
  const threshold = config.sentenceLengthCVThreshold;
  const base = baseResult('sentenceLengthCV', threshold);
  const lengths = sentences.map((sentence) => wordTokens(sentence).length).filter((length) => length > 0);
  if (lengths.length < 2) return { ...base, skipped: true };
  const value = coefficientOfVariation(lengths);
  return { ...base, value, pass: value >= threshold, score: scoreBelowLimit(value, threshold) };
}

function detectLexicalDiversity(tokens: string[], config: DetectorConfig): MetricResult {
  const threshold = config.lexicalDiversityThreshold;
  const base = baseResult('lexicalDiversity', threshold);
  if (tokens.length === 0) return { ...base, skipped: true };
  const value = movingAverageTypeTokenRatio(tokens);
  return { ...base, value, pass: value >= threshold, score: scoreBelowLimit(value, threshold) };
}

function detectTemplatePhrase(sentences: string[], wordCount: number, config: DetectorConfig): MetricResult {
  const threshold = config.templatePhrasePerKiloWordThreshold;
  const base = baseResult('templatePhrase', threshold);
  if (wordCount === 0) return { ...base, skipped: true };
  const hits: number[] = [];
  let totalHits = 0;
  sentences.forEach((sentence, index) => {
    let inSentence = 0;
    for (const phrase of TEMPLATE_PHRASES) inSentence += countOccurrences(sentence, phrase);
    if (inSentence > 0) hits.push(index);
    totalHits += inSentence;
  });
  const value = totalHits / (wordCount / 1000); // 每千词命中数
  return { ...base, value, pass: value <= threshold, score: scoreAboveLimit(value, threshold), hits };
}

function detectPunctuationCV(text: string, config: DetectorConfig): MetricResult {
  const threshold: MetricThreshold = { min: config.punctuationCVMin, max: config.punctuationCVMax };
  const base = baseResult('punctuationCV', threshold);
  const intervals: number[] = [];
  let sinceLastPunctuation = 0;
  let lastWasPunctuation = false;
  for (const ch of text.replace(/\s+/g, '')) {
    if (PUNCTUATION.has(ch)) {
      if (!lastWasPunctuation) intervals.push(sinceLastPunctuation); // 连续标点合一次事件
      sinceLastPunctuation = 0;
      lastWasPunctuation = true;
    } else {
      sinceLastPunctuation += 1;
      lastWasPunctuation = false;
    }
  }
  if (intervals.length < 2) return { ...base, skipped: true };
  const value = coefficientOfVariation(intervals);
  return {
    ...base,
    value,
    pass: value >= config.punctuationCVMin && value <= config.punctuationCVMax,
    score: scoreOutsideRange(value, config.punctuationCVMin, config.punctuationCVMax),
  };
}

function detectDialogueRatio(sentences: string[], config: DetectorConfig): MetricResult {
  const threshold: MetricThreshold = { min: config.dialogueRatioMin, max: config.dialogueRatioMax };
  const base = baseResult('dialogueRatio', threshold);
  const hits: number[] = [];
  let dialogueChars = 0;
  let totalChars = 0;
  sentences.forEach((sentence, index) => {
    let closing: string | null = null;
    let inDialogueChars = 0;
    for (const ch of sentence) {
      if (/\s/.test(ch)) continue;
      totalChars += 1;
      if (closing !== null) {
        if (ch === closing) {
          closing = null;
        } else {
          inDialogueChars += 1;
        }
        continue;
      }
      const next = OPEN_QUOTES[ch];
      if (next !== undefined) closing = next;
    }
    if (inDialogueChars > 0) hits.push(index);
    dialogueChars += inDialogueChars;
  });
  if (totalChars === 0) return { ...base, skipped: true };
  const value = dialogueChars / totalChars;
  return {
    ...base,
    value,
    pass: value >= config.dialogueRatioMin && value <= config.dialogueRatioMax,
    score: scoreOutsideRange(value, config.dialogueRatioMin, config.dialogueRatioMax),
    hits,
  };
}

function detectEmotionDensity(sentences: string[], wordCount: number, config: DetectorConfig): MetricResult {
  const threshold: MetricThreshold = { min: config.emotionDensityMin, max: config.emotionDensityMax };
  const base = baseResult('emotionDensity', threshold);
  if (wordCount === 0) return { ...base, skipped: true };
  const hits: number[] = [];
  let totalHits = 0;
  sentences.forEach((sentence, index) => {
    let inSentence = 0;
    for (const word of EMOTION_WORDS) inSentence += countOccurrences(sentence, word);
    if (inSentence > 0) hits.push(index);
    totalHits += inSentence;
  });
  const value = totalHits / wordCount;
  return {
    ...base,
    value,
    pass: value >= config.emotionDensityMin && value <= config.emotionDensityMax,
    score: scoreOutsideRange(value, config.emotionDensityMin, config.emotionDensityMax),
    hits,
  };
}

function detectSemanticSmoothness(sentences: string[], config: DetectorConfig): MetricResult {
  const threshold = config.semanticSmoothnessCVThreshold;
  const base = baseResult('semanticSmoothness', threshold);
  const contentSets = sentences.map((sentence) => new Set(wordTokens(sentence).filter((token) => token.length >= 2)));
  if (contentSets.length < 3) return { ...base, skipped: true };
  const overlaps: number[] = [];
  for (let i = 0; i + 1 < contentSets.length; i++) {
    const current = contentSets[i]!;
    const next = contentSets[i + 1]!;
    let intersection = 0;
    for (const token of current) if (next.has(token)) intersection += 1;
    const union = current.size + next.size - intersection;
    overlaps.push(union === 0 ? 0 : intersection / union);
  }
  const value = coefficientOfVariation(overlaps);
  return { ...base, value, pass: value >= threshold, score: scoreBelowLimit(value, threshold) };
}
