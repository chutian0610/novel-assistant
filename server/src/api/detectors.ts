import { Hono } from 'hono';
import { z } from 'zod';
import type { DB } from '../db/open';
import { getDetectorConfig, updateDetectorConfig } from '../detectors/config';
import { analyzeText, type DetectorConfig } from '../detectors/metrics';
import { HttpError } from './errors';
import { parseBody, readJson } from './validate';

/** 阈值字段的合法范围：0~1 类比率阈值收紧到 (0,1)，节奏/平滑类 CV 允许到 10 */
const ratioRule = z.number().min(0.01, '应大于 0').max(0.95, '应小于 1');
const nonNegativeRule = z.number().min(0, '不能为负').max(1, '应不超过 1');
const cvRule = z.number().min(0.01, '应大于 0').max(10, '应不超过 10');
const perKiloRule = z.number().min(0, '不能为负').max(1000, '应不超过 1000');

const configPatchSchema = z
  .object({
    lexicalDiversityThreshold: ratioRule.optional(),
    sentenceLengthCVThreshold: cvRule.optional(),
    trigramRepetitionThreshold: nonNegativeRule.optional(),
    templatePhrasePerKiloWordThreshold: perKiloRule.optional(),
    punctuationCVMin: cvRule.optional(),
    punctuationCVMax: cvRule.optional(),
    dialogueRatioMin: nonNegativeRule.optional(),
    dialogueRatioMax: nonNegativeRule.optional(),
    emotionDensityMin: nonNegativeRule.optional(),
    emotionDensityMax: nonNegativeRule.optional(),
    semanticSmoothnessCVThreshold: cvRule.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, '至少提供一个要更新的字段');

const analyzeSchema = z
  .object({ text: z.string().trim().min(1, '文本不能为空').max(200_000, '文本过长（上限 20 万字）') })
  .strict();

/** 区间字段的交叉校验：合并现值后 min ≤ max，违反 → 400 */
function assertRangesSane(current: DetectorConfig, patch: Partial<DetectorConfig>): void {
  const merged = { ...current, ...patch };
  const pairs: [string, number, number][] = [
    ['punctuationCV', merged.punctuationCVMin, merged.punctuationCVMax],
    ['dialogueRatio', merged.dialogueRatioMin, merged.dialogueRatioMax],
    ['emotionDensity', merged.emotionDensityMin, merged.emotionDensityMax],
  ];
  for (const [name, min, max] of pairs) {
    if (min > max) throw new HttpError(400, `参数 ${name}：下限（${min}）不能大于上限（${max}）`);
  }
}

/**
 * 第八组路由：检测工具（T7）。纯确定性统计，无任何 LLM 依赖：
 * POST /detectors/analyze 出 8 维报告；GET/PUT /detectors/config 阈值配置。
 */
export function detectorsRoutes(deps: { db: DB }) {
  const { db } = deps;
  const app = new Hono();

  app.get('/detectors/config', (c) => c.json(getDetectorConfig(db)));

  app.put('/detectors/config', async (c) => {
    const patch = parseBody(configPatchSchema, await readJson(c));
    assertRangesSane(getDetectorConfig(db), patch);
    return c.json(updateDetectorConfig(db, patch));
  });

  app.post('/detectors/analyze', async (c) => {
    const { text } = parseBody(analyzeSchema, await readJson(c));
    return c.json(analyzeText(text, getDetectorConfig(db)));
  });

  return app;
}
