import { touchBook } from '../books/store';
import type { DetectionReport, MetricResult } from '../detectors/metrics';
import type { DB } from '../db/open';
import type { InjectionView } from '../packing/pack';

/** LLM 语义核查报告（verify 任务路由产出，对照事实库） */
export interface SemanticConflict {
  /** 正文中矛盾的原句 */
  quote: string;
  /** 矛盾说明 */
  explanation: string;
  /** 冲突的事实摘要（可为空串） */
  factHint: string;
}

export interface SemanticReport {
  conflicts: SemanticConflict[];
}

/**
 * 章节管线持久层（T10）：章节实例、版本快照、管线状态表三张表的数据访问。
 * 写路径只提供单语句/单表操作，跨表的事务编排（commit 原子落盘）由 run.ts 组合。
 */

/** 管线阶段：stage 记录「下一个待执行阶段」，done 表示全部完成 */
export const PIPELINE_STAGES = ['prepare', 'draft', 'verify', 'fix', 'commit', 'done'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** 管线状态：suspended = 闸门未过，挂起等待人工裁决（挂起队列处理） */
export const PIPELINE_STATUSES = ['running', 'done', 'failed', 'suspended'] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  prepare: '准备',
  draft: '草稿',
  verify: '核查',
  fix: '修订',
  commit: '落盘',
  done: '完成',
};

export const PIPELINE_STATUS_LABELS: Record<PipelineStatus, string> = {
  running: '进行中',
  done: '已完成',
  failed: '失败',
  suspended: '已挂起',
};

/** 快照来源：管线 commit / 人工编辑 / 快照回退 */
export type SnapshotSource = 'pipeline' | 'edit' | 'revert';

export interface PipelineRunRecord {
  bookId: number;
  /** 章号（1 起，大纲树顺序） */
  idx: number;
  stage: PipelineStage;
  status: PipelineStatus;
  /** 已执行的阶段步数（含失败尝试；断点续跑累计） */
  attempts: number;
  error: string | null;
  /** prepare 产物：注入视图（落盘为 JSON，draft 复用，断点续跑不重算） */
  preparedView: InjectionView | null;
  /** draft/fix 产物：当前正文草稿（commit 复用） */
  draftContent: string | null;
  /** 已执行的定向重写轮数 */
  fixRounds: number;
  /** verify 产物：8 维检测报告（双报告之一；fix 每轮重写后清空待复检） */
  detectionReport: DetectionReport | null;
  /** verify 产物：LLM 语义核查报告（双报告之二） */
  semanticReport: SemanticReport | null;
  /** 落稿后事实回灌的失败信息（null = 已回灌或无需回灌）；失败不阻塞提交，可手动重灌 */
  extractError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterRecord {
  bookId: number;
  idx: number;
  /** 生成时章纲标题的快照（章纲后续改名不影响已生成章节） */
  title: string;
  outlineId: number | null;
  content: string;
  /** 滚动摘要（content 的派生物，随每次正文写入同步重算） */
  summary: string;
  charCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterSnapshotRecord {
  id: number;
  content: string;
  summary: string;
  source: SnapshotSource;
  createdAt: string;
}

interface RunRow {
  id: number;
  book_id: number;
  idx: number;
  stage: PipelineStage;
  status: PipelineStatus;
  attempts: number;
  error: string | null;
  prepared_view: string | null;
  draft_content: string | null;
  fix_rounds: number;
  detection_report: string | null;
  semantic_report: string | null;
  extract_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ChapterRow {
  id: number;
  book_id: number;
  idx: number;
  title: string;
  outline_id: number | null;
  content: string;
  summary: string;
  created_at: string;
  updated_at: string;
}

interface SnapshotRow {
  id: number;
  content: string;
  summary: string;
  source: SnapshotSource;
  created_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// ---------- 管线状态表 ----------

function toRunRecord(row: RunRow): PipelineRunRecord {
  return {
    bookId: row.book_id,
    idx: row.idx,
    stage: row.stage,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    preparedView: parsePreparedView(row.prepared_view),
    draftContent: row.draft_content,
    fixRounds: row.fix_rounds,
    detectionReport: parseJson(row.detection_report) as DetectionReport | null,
    semanticReport: parseJson(row.semantic_report) as SemanticReport | null,
    extractError: row.extract_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 落盘 JSON → 对象；脏值统一按缺失处理（断点续跑据此重跑该阶段） */
function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function parsePreparedView(raw: string | null): InjectionView | null {
  return parseJson(raw) as InjectionView | null;
}

export function getRun(db: DB, bookId: number, idx: number): PipelineRunRecord | null {
  const row = db
    .prepare('SELECT * FROM pipeline_runs WHERE book_id = ? AND idx = ?')
    .get(bookId, idx) as RunRow | undefined;
  return row ? toRunRecord(row) : null;
}

export function createRun(db: DB, bookId: number, idx: number): void {
  db.prepare('INSERT INTO pipeline_runs (book_id, idx) VALUES (?, ?)').run(bookId, idx);
}

export interface RunStagePatch {
  stage: PipelineStage;
  status: PipelineStatus;
  /** 本次执行累计后的阶段步数 */
  attempts: number;
  error: string | null;
  /** 传入则覆写 prepare 产物 */
  preparedView?: InjectionView | null;
  /** 传入则覆写 draft/fix 产物 */
  draftContent?: string | null;
  /** 传入则覆写 fix 轮数 */
  fixRounds?: number;
  /** 传入则覆写检测报告（null = 清空待复检） */
  detectionReport?: DetectionReport | null;
  /** 传入则覆写语义核查报告（null = 清空待复检） */
  semanticReport?: SemanticReport | null;
  /** 传入则覆写事实回灌失败信息 */
  extractError?: string | null;
}

/** 运行状态推进统一入口：每次阶段执行（成功或失败）恰好调用一次、attempts 由调用方累计；
 *  少数非阶段旁路标记（如回灌结果 settleFactSync）也经此入口落盘，复用既有 attempts。 */
export function advanceRun(db: DB, bookId: number, idx: number, patch: RunStagePatch): void {
  const assignments = [
    'stage = ?',
    'status = ?',
    'attempts = ?',
    'error = ?',
    patch.preparedView !== undefined ? 'prepared_view = ?' : null,
    patch.draftContent !== undefined ? 'draft_content = ?' : null,
    patch.fixRounds !== undefined ? 'fix_rounds = ?' : null,
    patch.detectionReport !== undefined ? 'detection_report = ?' : null,
    patch.semanticReport !== undefined ? 'semantic_report = ?' : null,
    patch.extractError !== undefined ? 'extract_error = ?' : null,
    `updated_at = ${NOW}`,
  ].filter((item): item is string => item !== null);
  const values: (string | number | null)[] = [
    patch.stage,
    patch.status,
    patch.attempts,
    patch.error,
  ];
  if (patch.preparedView !== undefined) {
    values.push(patch.preparedView === null ? null : JSON.stringify(patch.preparedView));
  }
  if (patch.draftContent !== undefined) {
    values.push(patch.draftContent);
  }
  if (patch.fixRounds !== undefined) {
    values.push(patch.fixRounds);
  }
  if (patch.detectionReport !== undefined) {
    values.push(patch.detectionReport === null ? null : JSON.stringify(patch.detectionReport));
  }
  if (patch.semanticReport !== undefined) {
    values.push(patch.semanticReport === null ? null : JSON.stringify(patch.semanticReport));
  }
  if (patch.extractError !== undefined) {
    values.push(patch.extractError);
  }
  values.push(bookId, idx);
  db.prepare(`UPDATE pipeline_runs SET ${assignments.join(', ')} WHERE book_id = ? AND idx = ?`).run(...values);
}

// ---------- 章节 ----------

function toChapterRecord(row: ChapterRow): ChapterRecord {
  return {
    bookId: row.book_id,
    idx: row.idx,
    title: row.title,
    outlineId: row.outline_id,
    content: row.content,
    summary: row.summary,
    charCount: row.content.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getChapter(db: DB, bookId: number, idx: number): ChapterRecord | null {
  const row = db
    .prepare('SELECT * FROM chapters WHERE book_id = ? AND idx = ?')
    .get(bookId, idx) as ChapterRow | undefined;
  return row ? toChapterRecord(row) : null;
}

export function listChapters(db: DB, bookId: number): ChapterRecord[] {
  const rows = db
    .prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx')
    .all(bookId) as ChapterRow[];
  return rows.map(toChapterRecord);
}

export interface ChapterCommitInput {
  title: string;
  outlineId: number | null;
  content: string;
  summary: string;
}

/** commit 阶段的章节落盘（upsert）：新章插入，重生成覆写正文/标题/章纲指向 */
export function upsertChapter(db: DB, bookId: number, idx: number, input: ChapterCommitInput): number {
  const existing = db
    .prepare('SELECT id FROM chapters WHERE book_id = ? AND idx = ?')
    .get(bookId, idx) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE chapters SET title = ?, outline_id = ?, content = ?, summary = ?, updated_at = ${NOW}
       WHERE book_id = ? AND idx = ?`
    ).run(input.title, input.outlineId, input.content, input.summary, bookId, idx);
    return existing.id;
  }
  const info = db
    .prepare('INSERT INTO chapters (book_id, idx, title, outline_id, content, summary) VALUES (?, ?, ?, ?, ?, ?)')
    .run(bookId, idx, input.title, input.outlineId, input.content, input.summary);
  return Number(info.lastInsertRowid);
}

/** 正文人工写入（编辑/回退共用）：正文 + 摘要派生物同步更新 */
export function updateChapterContent(
  db: DB,
  bookId: number,
  idx: number,
  content: string,
  summary: string
): void {
  db.prepare(
    `UPDATE chapters SET content = ?, summary = ?, updated_at = ${NOW} WHERE book_id = ? AND idx = ?`
  ).run(content, summary, bookId, idx);
  touchBook(db, bookId);
}

// ---------- 版本快照 ----------

function toSnapshotRecord(row: SnapshotRow): ChapterSnapshotRecord {
  return {
    id: row.id,
    content: row.content,
    summary: row.summary,
    source: row.source,
    createdAt: row.created_at,
  };
}

export function insertSnapshot(
  db: DB,
  chapterId: number,
  content: string,
  summary: string,
  source: SnapshotSource
): void {
  db.prepare('INSERT INTO chapter_snapshots (chapter_id, content, summary, source) VALUES (?, ?, ?, ?)').run(
    chapterId,
    content,
    summary,
    source
  );
}

/** 某章的全部快照，最新在前 */
export function listSnapshots(db: DB, chapterId: number): ChapterSnapshotRecord[] {
  const rows = db
    .prepare('SELECT id, content, summary, source, created_at FROM chapter_snapshots WHERE chapter_id = ? ORDER BY id DESC')
    .all(chapterId) as SnapshotRow[];
  return rows.map(toSnapshotRecord);
}

/** 取属于指定章节的快照（回退前校验归属）；chapterId 经 getChapterId 解析 */
export function getSnapshot(db: DB, chapterId: number, snapshotId: number): ChapterSnapshotRecord | null {
  const row = db
    .prepare('SELECT id, content, summary, source, created_at FROM chapter_snapshots WHERE chapter_id = ? AND id = ?')
    .get(chapterId, snapshotId) as SnapshotRow | undefined;
  return row ? toSnapshotRecord(row) : null;
}

export function getChapterId(db: DB, bookId: number, idx: number): number | null {
  const row = db.prepare('SELECT id FROM chapters WHERE book_id = ? AND idx = ?').get(bookId, idx) as
    | { id: number }
    | undefined;
  return row ? row.id : null;
}

// ---------- commit（generate 与挂起队列动作共用的落盘出口） ----------

/** 滚动摘要：压平全部空白后取前 N 字，截断补省略号（content 的确定性派生物） */
export const SUMMARY_MAX_CHARS = 200;

export function deriveSummary(content: string): string {
  const flat = content.replace(/\s+/g, '');
  return flat.length <= SUMMARY_MAX_CHARS ? flat : `${flat.slice(0, SUMMARY_MAX_CHARS)}……`;
}

/** 注入视图中的章纲条目（commit 的标题/章纲指向来源） */
function chapterOutlineTarget(view: InjectionView): { title: string; refId: number | null } {
  const item = view.layers
    .flatMap((layer) => layer.items)
    .find((item) => item.refType === 'chapter-outline');
  if (!item) throw new Error('注入视图缺少章纲条目（buildInjectionView 契约被破坏）');
  return { title: item.title, refId: item.refId };
}

export interface CommitOutcome {
  chapterId: number;
  chapter: ChapterRecord;
  run: PipelineRunRecord;
  snapshots: ChapterSnapshotRecord[];
}

/**
 * commit 阶段：单事务原子落盘（正文 + 版本快照 + run 终态）。
 * 闸门放行后的唯一出口：generate 主流程与挂起队列的重写/裁决动作都经由这里收尾。
 */
export function commitChapterRun(db: DB, bookId: number, idx: number): CommitOutcome {
  const run = getRun(db, bookId, idx);
  if (!run) throw new Error('管线状态缺失');
  const draft = run.draftContent;
  if (draft === null) throw new Error('draft 产物缺失（断点状态不一致）');
  if (!run.preparedView) throw new Error('prepare 产物缺失（断点状态不一致）');
  const target = chapterOutlineTarget(run.preparedView);
  const summary = deriveSummary(draft);
  const chapterId = db.transaction((): number => {
    const id = upsertChapter(db, bookId, idx, {
      title: target.title,
      outlineId: target.refId,
      content: draft,
      summary,
    });
    insertSnapshot(db, id, draft, summary, 'pipeline');
    advanceRun(db, bookId, idx, { stage: 'done', status: 'done', attempts: run.attempts + 1, error: null });
    touchBook(db, bookId);
    return id;
  })();

  const chapter = getChapter(db, bookId, idx);
  if (!chapter) throw new Error('commit 事务后章节缺失（事务原子性被破坏）');
  return { chapterId, chapter, run: getRun(db, bookId, idx)!, snapshots: listSnapshots(db, chapterId) };
}

// ---------- 运行状态摘要投影（列表/队列/连跑等重负载场景共用） ----------

/** 运行状态摘要（不带注入视图与双报告）；与 web/src/types.ts CompactRun 镜像同步 */
export interface CompactRun {
  stage: PipelineStage;
  status: PipelineStatus;
  attempts: number;
  fixRounds: number;
  error: string | null;
  extractError: string | null;
}

export function toCompactRun(run: PipelineRunRecord): CompactRun {
  return {
    stage: run.stage,
    status: run.status,
    attempts: run.attempts,
    fixRounds: run.fixRounds,
    error: run.error,
    extractError: run.extractError,
  };
}

// ---------- 指标落库（verify 双报告之一，跨章趋势数据源） ----------

export interface ChapterMetricsRecord {
  bookId: number;
  idx: number;
  aiScore: number;
  confidence: number;
  adjustedScore: number;
  wordCount: number;
  /** 8 维指标结果（不含正文句子，报告全文挂在 run 上） */
  metrics: MetricResult[];
  createdAt: string;
  updatedAt: string;
}

interface MetricsRow {
  book_id: number;
  idx: number;
  ai_score: number;
  confidence: number;
  adjusted_score: number;
  word_count: number;
  metrics: string;
  created_at: string;
  updated_at: string;
}

function toMetricsRecord(row: MetricsRow): ChapterMetricsRecord {
  return {
    bookId: row.book_id,
    idx: row.idx,
    aiScore: row.ai_score,
    confidence: row.confidence,
    adjustedScore: row.adjusted_score,
    wordCount: row.word_count,
    metrics: (parseJson(row.metrics) as MetricResult[] | null) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MetricsUpsertInput {
  aiScore: number;
  confidence: number;
  adjustedScore: number;
  wordCount: number;
  metrics: MetricResult[];
}

/** verify 完成（或人工编辑重算）时 upsert 指标：每章保留最新一份 */
export function upsertChapterMetrics(db: DB, bookId: number, idx: number, input: MetricsUpsertInput): void {
  db.prepare(
    `INSERT INTO chapter_metrics (book_id, idx, ai_score, confidence, adjusted_score, word_count, metrics)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (book_id, idx) DO UPDATE SET
       ai_score = excluded.ai_score,
       confidence = excluded.confidence,
       adjusted_score = excluded.adjusted_score,
       word_count = excluded.word_count,
       metrics = excluded.metrics,
       updated_at = ${NOW}`
  ).run(bookId, idx, input.aiScore, input.confidence, input.adjustedScore, input.wordCount, JSON.stringify(input.metrics));
}

/** 全书指标，按章号升序（跨章趋势） */
export function listChapterMetrics(db: DB, bookId: number): ChapterMetricsRecord[] {
  const rows = db
    .prepare('SELECT * FROM chapter_metrics WHERE book_id = ? ORDER BY idx')
    .all(bookId) as MetricsRow[];
  return rows.map(toMetricsRecord);
}

// ---------- 挂起队列（闸门未过的人工裁决清单） ----------

export type SuspensionSource = 'detection' | 'semantic';
export type SuspensionResolution = 'rewrite' | 'ignore' | 'fact' | 'auto';

export interface SuspensionDetail {
  /** 检测项：命中的指标键 */
  metricKey?: string;
  /** 检测项：问题句索引与原文 */
  hits?: number[];
  sentences?: string[];
  /** 全文级维度聚合项：无法定位段落的维度键列表 */
  metricKeys?: string[];
  fullText?: boolean;
  /** 语义项：矛盾原句（重写定位用） */
  quote?: string;
  explanation?: string;
  factHint?: string;
}

export interface SuspensionRecord {
  id: number;
  bookId: number;
  idx: number;
  source: SuspensionSource;
  title: string;
  reason: string;
  detail: SuspensionDetail;
  /** 创建时的 fix 轮次：闸门只看当前轮的检测项 */
  round: number;
  status: 'pending' | 'resolved';
  resolution: SuspensionResolution | null;
  createdAt: string;
  updatedAt: string;
}

interface SuspensionRow {
  id: number;
  book_id: number;
  idx: number;
  source: SuspensionSource;
  title: string;
  reason: string;
  detail: string;
  round: number;
  status: 'pending' | 'resolved';
  resolution: SuspensionResolution | null;
  created_at: string;
  updated_at: string;
}

function toSuspensionRecord(row: SuspensionRow): SuspensionRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    idx: row.idx,
    source: row.source,
    title: row.title,
    reason: row.reason,
    detail: (parseJson(row.detail) as SuspensionDetail | null) ?? {},
    round: row.round,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSuspension(
  db: DB,
  bookId: number,
  idx: number,
  input: {
    source: SuspensionSource;
    title: string;
    reason?: string;
    detail: SuspensionDetail;
    round: number;
  }
): void {
  db.prepare(
    'INSERT INTO pipeline_suspensions (book_id, idx, source, title, reason, detail, round) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(bookId, idx, input.source, input.title, input.reason ?? '', JSON.stringify(input.detail), input.round);
}

export function getSuspension(db: DB, bookId: number, idx: number, id: number): SuspensionRecord | null {
  const row = db
    .prepare('SELECT * FROM pipeline_suspensions WHERE book_id = ? AND idx = ? AND id = ?')
    .get(bookId, idx, id) as SuspensionRow | undefined;
  return row ? toSuspensionRecord(row) : null;
}

/** 挂起队列：默认全部（最新在前），可按 pending 过滤；可按书聚合或按章过滤 */
export function listSuspensions(db: DB, bookId: number, options: { idx?: number; pendingOnly?: boolean } = {}): SuspensionRecord[] {
  const clauses = ['book_id = ?'];
  const values: (number | string)[] = [bookId];
  if (options.idx !== undefined) {
    clauses.push('idx = ?');
    values.push(options.idx);
  }
  if (options.pendingOnly) {
    clauses.push("status = 'pending'");
  }
  const rows = db
    .prepare(`SELECT * FROM pipeline_suspensions WHERE ${clauses.join(' AND ')} ORDER BY id DESC`)
    .all(...values) as SuspensionRow[];
  return rows.map(toSuspensionRecord);
}

export function countPendingSuspensions(db: DB, bookId: number, idx: number, source?: SuspensionSource): number {
  const row = (
    source
      ? db
          .prepare(
            "SELECT COUNT(*) AS count FROM pipeline_suspensions WHERE book_id = ? AND idx = ? AND source = ? AND status = 'pending'"
          )
          .get(bookId, idx, source)
      : db
          .prepare("SELECT COUNT(*) AS count FROM pipeline_suspensions WHERE book_id = ? AND idx = ? AND status = 'pending'")
          .get(bookId, idx)
  ) as { count: number };
  return row.count;
}

/** 裁决/自动消除挂起项 */
export function resolveSuspension(db: DB, bookId: number, idx: number, id: number, resolution: SuspensionResolution): void {
  db.prepare(
    `UPDATE pipeline_suspensions SET status = 'resolved', resolution = ?, updated_at = ${NOW}
     WHERE book_id = ? AND idx = ? AND id = ?`
  ).run(resolution, bookId, idx, id);
}
