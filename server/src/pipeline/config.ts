import type { DB } from '../db/open';

/**
 * 介入点预设（T13，ADR-0001）：协作 / 全自动是同一管线的两个预设，不是两套系统。
 * - collaborative（协作）：逐章审阅——生成一章停一章，作者审草稿后再继续（单章 generate 即是）；
 * - auto（全自动）：连跑，一次调用连续生成至 auto_run_limit 章后自动暂停待审。
 * 存储为键值表（v12），取值白名单与范围由本模块把守（同 detector_configs 口径）。
 * 「检查点可自定义」的 V1 口径 = 预设选择 + 连跑上限调整：审大纲闸门即章纲批准前置，
 * 审草稿闸门即协作预设的逐章审阅，二者不单列开关（见 issue #14 验收口径）。
 */

export const INTERVENTION_MODES = ['collaborative', 'auto'] as const;
export type InterventionMode = (typeof INTERVENTION_MODES)[number];

/** 连跑上限默认值与可配范围（spec Further Notes：默认 5，可调整） */
export const DEFAULT_AUTO_RUN_LIMIT = 5;
export const MAX_AUTO_RUN_LIMIT = 20;

export interface PipelineConfig {
  mode: InterventionMode;
  autoRunLimit: number;
}

interface ConfigRow {
  key: string;
  value: string;
}

const MODE_KEY = 'mode';
const LIMIT_KEY = 'auto_run_limit';

/** 读管线预设：表值合并进默认结构（缺键回退默认，脏值/脏键忽略） */
export function getPipelineConfig(db: DB): PipelineConfig {
  const rows = db.prepare('SELECT key, value FROM pipeline_configs').all() as ConfigRow[];
  const config: PipelineConfig = { mode: 'collaborative', autoRunLimit: DEFAULT_AUTO_RUN_LIMIT };
  for (const row of rows) {
    if (row.key === MODE_KEY && INTERVENTION_MODES.includes(row.value as InterventionMode)) {
      config.mode = row.value as InterventionMode;
    }
    if (row.key === LIMIT_KEY) {
      const limit = Number(row.value);
      if (Number.isInteger(limit) && limit >= 1 && limit <= MAX_AUTO_RUN_LIMIT) {
        config.autoRunLimit = limit;
      }
    }
  }
  return config;
}

/** 写管线预设（部分字段；键白名单内过滤，范围校验在 API 层 zod 完成，与 detector 同口径） */
export function updatePipelineConfig(db: DB, patch: Partial<PipelineConfig>): PipelineConfig {
  const update = db.prepare(
    `UPDATE pipeline_configs SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = ?`
  );
  const run = db.transaction(() => {
    if (patch.mode !== undefined && INTERVENTION_MODES.includes(patch.mode)) update.run(patch.mode, MODE_KEY);
    if (
      patch.autoRunLimit !== undefined &&
      Number.isInteger(patch.autoRunLimit) &&
      patch.autoRunLimit >= 1 &&
      patch.autoRunLimit <= MAX_AUTO_RUN_LIMIT
    ) {
      update.run(String(patch.autoRunLimit), LIMIT_KEY);
    }
  });
  run();
  return getPipelineConfig(db);
}
