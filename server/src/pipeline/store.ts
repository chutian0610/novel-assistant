import { touchBook } from '../books/store';
import type { DB } from '../db/open';
import type { InjectionView } from '../packing/pack';

/**
 * 章节管线持久层（T10）：章节实例、版本快照、管线状态表三张表的数据访问。
 * 写路径只提供单语句/单表操作，跨表的事务编排（commit 原子落盘）由 run.ts 组合。
 */

/** 管线阶段：stage 记录「下一个待执行阶段」，done 表示全部完成 */
export const PIPELINE_STAGES = ['prepare', 'draft', 'commit', 'done'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type PipelineStatus = 'running' | 'done' | 'failed';

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  prepare: '准备',
  draft: '草稿',
  commit: '落盘',
  done: '完成',
};

export const PIPELINE_STATUS_LABELS: Record<PipelineStatus, string> = {
  running: '进行中',
  done: '已完成',
  failed: '失败',
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
  /** draft 产物：正文草稿（commit 复用） */
  draftContent: string | null;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePreparedView(raw: string | null): InjectionView | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as InjectionView;
  } catch {
    return null;
  }
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
  /** 传入则覆写 draft 产物 */
  draftContent?: string | null;
}

/** 阶段推进统一入口：每次阶段执行（成功或失败）恰好调用一次，attempts 由调用方累计 */
export function advanceRun(db: DB, bookId: number, idx: number, patch: RunStagePatch): void {
  const assignments = [
    'stage = ?',
    'status = ?',
    'attempts = ?',
    'error = ?',
    patch.preparedView !== undefined ? 'prepared_view = ?' : null,
    patch.draftContent !== undefined ? 'draft_content = ?' : null,
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
