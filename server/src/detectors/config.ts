import type { DB } from '../db/open';
import { DEFAULT_DETECTOR_CONFIG, type DetectorConfig } from './metrics';

/** 键白名单 = 默认配置的键集；detector_configs 表不加 CHECK 约束，脏键在此处被忽略 */
const CONFIG_KEYS = Object.keys(DEFAULT_DETECTOR_CONFIG) as (keyof DetectorConfig)[];

function isConfigKey(key: string): key is keyof DetectorConfig {
  return (CONFIG_KEYS as string[]).includes(key);
}

/** 读阈值配置：表值合并进默认结构（缺键回退默认，脏值/脏键忽略） */
export function getDetectorConfig(db: DB): DetectorConfig {
  const rows = db.prepare('SELECT key, value FROM detector_configs').all() as { key: string; value: unknown }[];
  const merged: DetectorConfig = { ...DEFAULT_DETECTOR_CONFIG };
  for (const row of rows) {
    if (isConfigKey(row.key) && typeof row.value === 'number' && Number.isFinite(row.value)) {
      merged[row.key] = row.value;
    }
  }
  return merged;
}

/** 写阈值配置（部分字段），返回更新后的完整配置。键校验与范围校验在 API 层 zod 完成 */
export function updateDetectorConfig(db: DB, patch: Partial<DetectorConfig>): DetectorConfig {
  const entries = Object.entries(patch).filter(([key]) => isConfigKey(key));
  if (entries.length > 0) {
    const update = db.prepare(
      `UPDATE detector_configs SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = ?`
    );
    const run = db.transaction(() => {
      for (const [key, value] of entries) update.run(value, key);
    });
    run();
  }
  return getDetectorConfig(db);
}
