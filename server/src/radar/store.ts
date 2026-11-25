import type { DB } from '../db/open';
import { getPipelineConfig } from '../pipeline/config';
import { listChapters } from '../pipeline/store';

/**
 * 爽点雷达存储（T18，观测与预警维度）：语义标注按章落库，跨章统计纯代码。
 * 边界（spec）：不进重写闸门、不挂起、不触发 fix——裁决权在作者。
 */

export const THRILL_TYPES = ['face_slap', 'breakthrough', 'reversal', 'gain', 'other'] as const;
export type ThrillType = (typeof THRILL_TYPES)[number];

export const THRILL_TYPE_LABELS: Record<ThrillType, string> = {
  face_slap: '打脸',
  breakthrough: '晋级',
  reversal: '反转',
  gain: '获得',
  other: '其他',
};

export const HOOK_RATINGS = ['strong', 'medium', 'weak', 'none'] as const;
export type HookRating = (typeof HOOK_RATINGS)[number];

export const HOOK_RATING_LABELS: Record<HookRating, string> = {
  strong: '强钩子',
  medium: '中钩子',
  weak: '弱钩子',
  none: '无钩子',
};

export interface RadarMarkRecord {
  id: number;
  bookId: number;
  idx: number;
  kind: 'thrill' | 'hook';
  /** thrill：爽点类型；hook：钩子评级 */
  type: string;
  quote: string;
  /** thrill：1-5 强度；hook 恒 0 */
  intensity: number;
  reason: string;
  spanStart: number | null;
  spanEnd: number | null;
  origin: 'auto' | 'manual';
  createdAt: string;
}

export interface AnalyzedThrill {
  type: ThrillType;
  quote: string;
  intensity: number;
  reason: string;
  spanStart: number | null;
  spanEnd: number | null;
}

export interface AnalyzedHook {
  rating: HookRating;
  quote: string;
  reason: string;
  spanStart: number | null;
  spanEnd: number | null;
}

export interface AnalyzedRadar {
  thrills: AnalyzedThrill[];
  hook: AnalyzedHook | null;
}

interface MarkRow {
  id: number;
  book_id: number;
  idx: number;
  kind: 'thrill' | 'hook';
  type: string;
  quote: string;
  intensity: number;
  reason: string;
  span_start: number | null;
  span_end: number | null;
  origin: 'auto' | 'manual';
  created_at: string;
}

function toRecord(row: MarkRow): RadarMarkRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    idx: row.idx,
    kind: row.kind,
    type: row.type,
    quote: row.quote,
    intensity: row.intensity,
    reason: row.reason,
    spanStart: row.span_start,
    spanEnd: row.span_end,
    origin: row.origin,
    createdAt: row.created_at,
  };
}

/**
 * 幂等整章替换（与事实回灌 replaceAutoFacts 同契约）：删本章全部 auto 行后重插。
 * 同章重复 commit / 手动重灌不产生重复标注。
 */
export function replaceRadarMarks(db: DB, bookId: number, idx: number, analyzed: AnalyzedRadar): number {
  const insert = db.prepare(
    `INSERT INTO radar_marks (book_id, idx, kind, type, quote, intensity, reason, span_start, span_end, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')`
  );
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM radar_marks WHERE book_id = ? AND idx = ? AND origin = 'auto'`).run(bookId, idx);
    let count = 0;
    for (const thrill of analyzed.thrills) {
      insert.run(bookId, idx, 'thrill', thrill.type, thrill.quote, thrill.intensity, thrill.reason, thrill.spanStart, thrill.spanEnd);
      count += 1;
    }
    if (analyzed.hook) {
      insert.run(bookId, idx, 'hook', analyzed.hook.rating, analyzed.hook.quote, 0, analyzed.hook.reason, analyzed.hook.spanStart, analyzed.hook.spanEnd);
      count += 1;
    }
    return count;
  });
  return run();
}

/** 按章聚合的雷达视图：每章爽点标注 + 钩子评级（只含有标注的章） */
export interface RadarChapterSummary {
  idx: number;
  thrillCount: number;
  maxIntensity: number;
  hook: { rating: HookRating | string; quote: string; reason: string } | null;
  thrills: RadarMarkRecord[];
}

export function getRadarSummary(db: DB, bookId: number): RadarChapterSummary[] {
  const rows = db
    .prepare('SELECT * FROM radar_marks WHERE book_id = ? ORDER BY idx, kind DESC, intensity DESC, id')
    .all(bookId) as MarkRow[];
  const byChapter = new Map<number, RadarChapterSummary>();
  for (const row of rows) {
    let summary = byChapter.get(row.idx);
    if (!summary) {
      summary = { idx: row.idx, thrillCount: 0, maxIntensity: 0, hook: null, thrills: [] };
      byChapter.set(row.idx, summary);
    }
    const record = toRecord(row);
    if (row.kind === 'thrill') {
      summary.thrills.push(record);
      summary.thrillCount += 1;
      summary.maxIntensity = Math.max(summary.maxIntensity, record.intensity);
    } else {
      summary.hook = { rating: row.type, quote: record.quote, reason: record.reason };
    }
  }
  return [...byChapter.values()].sort((a, b) => a.idx - b.idx);
}

export interface DepressionWarning {
  /** 连续无爽点的已评测章数 */
  streak: number;
  window: number;
  fromIdx: number;
  toIdx: number;
}

/**
 * 连续压抑预警（纯代码跨章统计）：从最新已落稿章往下数连续「已评测且零爽点」的章；
 * 遇到有爽点的章或未评测的章（数据缺失，不臆断压抑）即停。streak ≥ 窗口时触发。
 */
export function getDepressionWarning(db: DB, bookId: number): DepressionWarning | null {
  const window = getPipelineConfig(db).radarDepressionWindow;
  const committed = listChapters(db, bookId);
  if (committed.length === 0) return null;
  const thrillByChapter = new Map<number, number>();
  for (const summary of getRadarSummary(db, bookId)) thrillByChapter.set(summary.idx, summary.thrillCount);

  let streak = 0;
  let toIdx = committed[committed.length - 1]!.idx;
  let fromIdx = toIdx;
  for (let i = committed.length - 1; i >= 0; i--) {
    const idx = committed[i]!.idx;
    const thrillCount = thrillByChapter.get(idx);
    if (thrillCount === undefined) break; // 未评测章：数据缺失，不臆断压抑
    if (thrillCount > 0) break; // 有爽点：压抑链断
    if (streak === 0) toIdx = idx;
    fromIdx = idx;
    streak += 1;
  }
  if (streak < window) return null;
  return { streak, window, fromIdx, toIdx };
}
