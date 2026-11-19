import { touchBook } from '../books/store';
import type { DB } from '../db/open';

/** 章纲状态机（spec 用户故事 18）：草稿→已批准→锁定；锁定仅可显式解锁回「已批准」 */
export const OUTLINE_STATUSES = ['draft', 'approved', 'locked'] as const;
export type OutlineStatus = (typeof OUTLINE_STATUSES)[number];

export const OUTLINE_STATUS_LABELS: Record<OutlineStatus, string> = {
  draft: '草稿',
  approved: '已批准',
  locked: '锁定',
};

export interface VolumeRecord {
  id: number;
  bookId: number;
  title: string;
  /** 卷纲内容：本卷叙事弧线概述 */
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterOutlineRecord {
  id: number;
  volumeId: number;
  title: string;
  /** 章纲内容：本章剧情展开概要 */
  summary: string;
  status: OutlineStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OutlineTree {
  volumes: (VolumeRecord & { chapters: ChapterOutlineRecord[] })[];
}

/** 锁定章纲的写操作守卫（API 层映射 409；未来章节管线复用同一守卫） */
export class OutlineLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutlineLockedError';
  }
}

/** 非法状态迁移（API 层映射 409） */
export class OutlineTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutlineTransitionError';
  }
}

/** 合法迁移表：其余一切组合（含同态、回退草稿、跳级锁定）均非法 */
const LEGAL_TRANSITIONS: Record<OutlineStatus, readonly OutlineStatus[]> = {
  draft: ['approved'],
  approved: ['locked'],
  locked: ['approved'],
};

export function isLegalTransition(from: OutlineStatus, to: OutlineStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

interface VolumeRow {
  id: number;
  book_id: number;
  title: string;
  summary: string;
  created_at: string;
  updated_at: string;
}

interface ChapterOutlineRow {
  id: number;
  volume_id: number;
  title: string;
  summary: string;
  status: OutlineStatus;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export interface OutlineWriteInput {
  title: string;
  summary: string;
}

// ---------- 卷纲：查询 ----------

export function listVolumes(db: DB, bookId: number): VolumeRecord[] {
  const rows = db
    .prepare('SELECT * FROM volumes WHERE book_id = ? ORDER BY id')
    .all(bookId) as VolumeRow[];
  return rows.map(toVolumeRecord);
}

export function getVolume(db: DB, bookId: number, volumeId: number): VolumeRecord | null {
  const row = db
    .prepare('SELECT * FROM volumes WHERE book_id = ? AND id = ?')
    .get(bookId, volumeId) as VolumeRow | undefined;
  return row ? toVolumeRecord(row) : null;
}

/** 全书大纲树：卷按创建顺序，各卷章纲按创建顺序 */
export function getOutlineTree(db: DB, bookId: number): OutlineTree {
  const volumes = listVolumes(db, bookId);
  const rows = db
    .prepare(
      `SELECT c.* FROM chapter_outlines c JOIN volumes v ON v.id = c.volume_id
       WHERE v.book_id = ? ORDER BY c.volume_id, c.id`
    )
    .all(bookId) as ChapterOutlineRow[];
  const byVolume = new Map<number, ChapterOutlineRecord[]>();
  for (const row of rows) {
    const list = byVolume.get(row.volume_id) ?? [];
    list.push(toChapterOutlineRecord(row));
    byVolume.set(row.volume_id, list);
  }
  return { volumes: volumes.map((volume) => ({ ...volume, chapters: byVolume.get(volume.id) ?? [] })) };
}

// ---------- 卷纲：写入 ----------

export function createVolume(db: DB, bookId: number, input: OutlineWriteInput): VolumeRecord | null {
  // 前导校验书存在：外键约束兜底，这里给出可捕获的 null 语义
  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(bookId);
  if (!book) return null;
  const info = db
    .prepare('INSERT INTO volumes (book_id, title, summary) VALUES (?, ?, ?)')
    .run(bookId, input.title, input.summary);
  return getVolume(db, bookId, Number(info.lastInsertRowid));
}

export function updateVolume(
  db: DB,
  bookId: number,
  volumeId: number,
  patch: Partial<OutlineWriteInput>
): VolumeRecord | null {
  const existing = getVolume(db, bookId, volumeId);
  if (!existing) return null;
  db.prepare(`UPDATE volumes SET title = ?, summary = ?, updated_at = ${NOW} WHERE id = ?`).run(
    patch.title ?? existing.title,
    patch.summary ?? existing.summary,
    volumeId
  );
  return getVolume(db, bookId, volumeId);
}

/** 删除卷纲；卷下存在锁定章纲时拒绝（锁定数据不可被连带销毁） */
export function deleteVolume(db: DB, bookId: number, volumeId: number): boolean {
  const run = db.transaction(() => {
    const volume = getVolume(db, bookId, volumeId);
    if (!volume) return false;
    const locked = db
      .prepare('SELECT COUNT(*) AS count FROM chapter_outlines WHERE volume_id = ? AND status = ?')
      .get(volumeId, 'locked') as { count: number };
    if (locked.count > 0) {
      throw new OutlineLockedError(`卷「${volume.title}」下有 ${locked.count} 条锁定章纲，不可删除；请先解锁`);
    }
    db.prepare('DELETE FROM volumes WHERE id = ?').run(volumeId);
    touchBook(db, bookId);
    return true;
  });
  return run();
}

// ---------- 章纲：查询 ----------

export function getChapterOutline(db: DB, bookId: number, chapterId: number): ChapterOutlineRecord | null {
  const row = db
    .prepare(
      `SELECT c.* FROM chapter_outlines c JOIN volumes v ON v.id = c.volume_id
       WHERE v.book_id = ? AND c.id = ?`
    )
    .get(bookId, chapterId) as ChapterOutlineRow | undefined;
  return row ? toChapterOutlineRecord(row) : null;
}

// ---------- 章纲：写入 ----------

export function createChapterOutline(
  db: DB,
  bookId: number,
  volumeId: number,
  input: OutlineWriteInput
): ChapterOutlineRecord | null {
  const run = db.transaction(() => {
    const volume = getVolume(db, bookId, volumeId);
    if (!volume) return null;
    const info = db
      .prepare('INSERT INTO chapter_outlines (volume_id, title, summary) VALUES (?, ?, ?)')
      .run(volumeId, input.title, input.summary);
    touchBook(db, bookId);
    return Number(info.lastInsertRowid);
  });
  const id = run();
  return id === null ? null : getChapterOutline(db, bookId, id);
}

/** 编辑章纲内容；锁定态拒绝（锁定章纲不可被管线或编辑改动） */
export function updateChapterOutline(
  db: DB,
  bookId: number,
  chapterId: number,
  patch: Partial<OutlineWriteInput>
): ChapterOutlineRecord | null {
  const run = db.transaction(() => {
    const existing = getChapterOutline(db, bookId, chapterId);
    if (!existing) return null;
    assertEditable(existing);
    db.prepare(
      `UPDATE chapter_outlines SET title = ?, summary = ?, updated_at = ${NOW} WHERE id = ?`
    ).run(patch.title ?? existing.title, patch.summary ?? existing.summary, chapterId);
    touchBook(db, bookId);
    return chapterId;
  });
  const id = run();
  return id === null ? null : getChapterOutline(db, bookId, id);
}

/** 删除章纲；锁定态拒绝 */
export function deleteChapterOutline(db: DB, bookId: number, chapterId: number): boolean {
  const run = db.transaction(() => {
    const existing = getChapterOutline(db, bookId, chapterId);
    if (!existing) return false;
    assertEditable(existing);
    db.prepare('DELETE FROM chapter_outlines WHERE id = ?').run(chapterId);
    touchBook(db, bookId);
    return true;
  });
  return run();
}

/**
 * 章纲状态流转（唯一入口）：仅允许 LEGAL_TRANSITIONS 内的组合；
 * 锁定态只放行 locked→approved（显式解锁），其余一切被拒。
 */
export function transitionChapterOutlineStatus(
  db: DB,
  bookId: number,
  chapterId: number,
  to: OutlineStatus
): ChapterOutlineRecord | null {
  const run = db.transaction(() => {
    const existing = getChapterOutline(db, bookId, chapterId);
    if (!existing) return null;
    const from = existing.status;
    if (!isLegalTransition(from, to)) {
      throw new OutlineTransitionError(
        `章纲「${existing.title}」不允许从「${OUTLINE_STATUS_LABELS[from]}」流转到「${OUTLINE_STATUS_LABELS[to]}」` +
          '（合法流转：草稿→已批准→锁定；锁定后仅可显式解锁）'
      );
    }
    db.prepare(`UPDATE chapter_outlines SET status = ?, updated_at = ${NOW} WHERE id = ?`).run(to, chapterId);
    touchBook(db, bookId);
    return chapterId;
  });
  const id = run();
  return id === null ? null : getChapterOutline(db, bookId, id);
}

// ---------- 内部 ----------

/** 锁定守卫：一切内容改动与删除在锁定态被拒（解锁是唯一的显式出口） */
function assertEditable(chapter: ChapterOutlineRecord): void {
  if (chapter.status === 'locked') {
    throw new OutlineLockedError(`章纲「${chapter.title}」已锁定，不可改动；请先显式解锁`);
  }
}

function toVolumeRecord(row: VolumeRow): VolumeRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    title: row.title,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toChapterOutlineRecord(row: ChapterOutlineRow): ChapterOutlineRecord {
  return {
    id: row.id,
    volumeId: row.volume_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
