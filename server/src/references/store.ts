import type { DB } from '../db/open';
import type { MaterialFieldPatch, MaterialPayload, MaterialType } from '../materials/store';

export type ReferenceFormat = 'txt' | 'epub';
export type ExtractionStatus = 'pending' | 'accepted' | 'rejected';
export type ExtractionResolution = 'new' | 'merge' | 'skip';

export interface ReferenceRecord {
  id: number;
  title: string;
  format: ReferenceFormat;
  chapterCount: number;
  /** 已完成 LLM 抽取的章节数（分章落盘后逐章抽取，可断点续跑） */
  extractedCount: number;
  pendingItemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterRecord {
  id: number;
  idx: number;
  title: string;
  content: string;
  charCount: number;
  extractStatus: 'pending' | 'done';
}

export interface ReferenceDetail extends ReferenceRecord {
  chapters: ChapterRecord[];
}

export interface ExtractionItemRecord {
  id: number;
  referenceId: number;
  chapterId: number;
  chapterTitle: string;
  type: MaterialType;
  title: string;
  content: string;
  payload: MaterialPayload;
  status: ExtractionStatus;
  resolution: ExtractionResolution | null;
  materialId: number | null;
  /** 重名碰撞提示：与全局库中同类型同名素材的指向（仅 pending 条目实时计算） */
  conflict: { materialId: number; title: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractedItemInput {
  chapterId: number;
  type: MaterialType;
  title: string;
  content: string;
  payload: MaterialPayload;
}

interface ReferenceRow {
  id: number;
  title: string;
  format: string;
  chapter_count: number;
  extracted_count: number;
  pending_item_count: number;
  created_at: string;
  updated_at: string;
}

interface ChapterRow {
  id: number;
  idx: number;
  title: string;
  content: string;
  extract_status: string;
}

interface ExtractionRow {
  id: number;
  reference_id: number;
  chapter_id: number;
  chapter_title: string;
  type: string;
  title: string;
  content: string;
  payload: string;
  status: string;
  resolution: string | null;
  material_id: number | null;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// ---------- 参考书 ----------

const REFERENCE_SELECT = `
  SELECT b.*,
    (SELECT COUNT(*) FROM reference_chapters c WHERE c.reference_id = b.id) AS chapter_count,
    (SELECT COUNT(*) FROM reference_chapters c WHERE c.reference_id = b.id AND c.extract_status = 'done') AS extracted_count,
    (SELECT COUNT(*) FROM extraction_items e WHERE e.reference_id = b.id AND e.status = 'pending') AS pending_item_count
  FROM reference_books b`;

export function createReference(db: DB, title: string, format: ReferenceFormat, chapters: { title: string; content: string }[]): ReferenceDetail {
  const run = db.transaction(() => {
    const info = db.prepare('INSERT INTO reference_books (title, format) VALUES (?, ?)').run(title, format);
    const referenceId = Number(info.lastInsertRowid);
    const insert = db.prepare(
      'INSERT INTO reference_chapters (reference_id, idx, title, content) VALUES (?, ?, ?, ?)'
    );
    chapters.forEach((chapter, index) => insert.run(referenceId, index + 1, chapter.title, chapter.content));
    return referenceId;
  });
  const id = run();
  return getReference(db, id)!;
}

export function listReferences(db: DB): { items: ReferenceRecord[]; total: number } {
  const rows = db.prepare(`${REFERENCE_SELECT} ORDER BY b.updated_at DESC, b.id DESC`).all() as ReferenceRow[];
  return { items: rows.map(toReferenceRecord), total: rows.length };
}

export function getReference(db: DB, id: number): ReferenceDetail | null {
  const row = db.prepare(`${REFERENCE_SELECT} WHERE b.id = ?`).get(id) as ReferenceRow | undefined;
  if (!row) return null;
  const chapters = db
    .prepare('SELECT id, idx, title, content, extract_status FROM reference_chapters WHERE reference_id = ? ORDER BY idx ASC')
    .all(id) as ChapterRow[];
  return {
    ...toReferenceRecord(row),
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      idx: chapter.idx,
      title: chapter.title,
      content: chapter.content,
      charCount: chapter.content.length,
      extractStatus: chapter.extract_status as ChapterRecord['extractStatus'],
    })),
  };
}

export function deleteReference(db: DB, id: number): boolean {
  return db.prepare('DELETE FROM reference_books WHERE id = ?').run(id).changes > 0;
}

/** 确认入库时的溯源书名（仅取 title，避免整本章节回读） */
export function getReferenceTitle(db: DB, id: number): string | null {
  const row = db.prepare('SELECT title FROM reference_books WHERE id = ?').get(id) as { title: string } | undefined;
  return row?.title ?? null;
}

// ---------- 章节（抽取状态） ----------

/** 待抽取章节：默认全部 pending 按 idx 顺序；指定 chapterIds 时只取其中仍 pending 的 */
export function pendingChapters(db: DB, referenceId: number, chapterIds?: number[]): ChapterRow[] {
  if (chapterIds && chapterIds.length > 0) {
    const placeholders = chapterIds.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT id, idx, title, content, extract_status FROM reference_chapters
         WHERE reference_id = ? AND extract_status = 'pending' AND id IN (${placeholders})
         ORDER BY idx ASC`
      )
      .all(referenceId, ...chapterIds) as ChapterRow[];
  }
  return db
    .prepare(
      `SELECT id, idx, title, content, extract_status FROM reference_chapters
       WHERE reference_id = ? AND extract_status = 'pending' ORDER BY idx ASC`
    )
    .all(referenceId) as ChapterRow[];
}

export function remainingChapterCount(db: DB, referenceId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM reference_chapters WHERE reference_id = ? AND extract_status = 'pending'")
      .get(referenceId) as { count: number }
  ).count;
}

export function markChapterDone(db: DB, chapterId: number): void {
  db.prepare("UPDATE reference_chapters SET extract_status = 'done' WHERE id = ?").run(chapterId);
}

// ---------- 抽取确认队列 ----------

const EXTRACTION_SELECT = `
  SELECT e.*, ch.title AS chapter_title
  FROM extraction_items e
  JOIN reference_chapters ch ON ch.id = e.chapter_id`;

export function insertExtractionItems(db: DB, items: ExtractedItemInput[]): void {
  const insert = db.prepare(
    'INSERT INTO extraction_items (reference_id, chapter_id, type, title, content, payload) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const run = db.transaction(() => {
    for (const item of items) {
      const { reference_id: referenceId } = db
        .prepare('SELECT reference_id FROM reference_chapters WHERE id = ?')
        .get(item.chapterId) as { reference_id: number };
      insert.run(referenceId, item.chapterId, item.type, item.title, item.content, JSON.stringify(item.payload));
    }
  });
  run();
}

export function listExtractionItems(db: DB, referenceId: number, status?: ExtractionStatus): { items: ExtractionItemRecord[]; total: number } {
  const clause = status ? `${EXTRACTION_SELECT} WHERE e.reference_id = ? AND e.status = ?` : `${EXTRACTION_SELECT} WHERE e.reference_id = ?`;
  const rows = (
    status ? db.prepare(`${clause} ORDER BY ch.idx ASC, e.id ASC`).all(referenceId, status) : db.prepare(`${clause} ORDER BY ch.idx ASC, e.id ASC`).all(referenceId)
  ) as ExtractionRow[];
  return { items: rows.map((row) => toExtractionRecord(db, row)), total: rows.length };
}

export function getExtractionItem(db: DB, id: number): ExtractionItemRecord | null {
  const row = db.prepare(`${EXTRACTION_SELECT} WHERE e.id = ?`).get(id) as ExtractionRow | undefined;
  return row ? toExtractionRecord(db, row) : null;
}

/** 确认前修改条目字段（payload 按键合并，与确认入库/书内覆写同语义）；仅 pending 可改，其余返回 null（由 API 映射 409） */
export function updateExtractionItem(db: DB, id: number, patch: MaterialFieldPatch): ExtractionItemRecord | null {
  const run = db.transaction(() => {
    const row = db.prepare('SELECT status FROM extraction_items WHERE id = ?').get(id) as { status: string } | undefined;
    if (!row || row.status !== 'pending') return null;
    const existing = db.prepare('SELECT title, content, payload FROM extraction_items WHERE id = ?').get(id) as {
      title: string;
      content: string;
      payload: string;
    };
    const payload: MaterialPayload = { ...parsePayload(existing.payload), ...patch.payload };
    db.prepare(
      `UPDATE extraction_items SET title = ?, content = ?, payload = ?, updated_at = ${NOW} WHERE id = ?`
    ).run(patch.title ?? existing.title, patch.content ?? existing.content, JSON.stringify(payload), id);
    return id;
  });
  const updated = run();
  return updated === null ? null : getExtractionItem(db, id);
}

/** 归档条目（accept/reject）；仅 pending 可归档，其余返回 null（由 API 映射 409） */
export function archiveExtractionItem(
  db: DB,
  id: number,
  status: 'accepted' | 'rejected',
  resolution?: ExtractionResolution,
  materialId?: number | null
): ExtractionItemRecord | null {
  const run = db.transaction(() => {
    const row = db.prepare('SELECT status FROM extraction_items WHERE id = ?').get(id) as { status: string } | undefined;
    if (!row || row.status !== 'pending') return null;
    db.prepare(
      `UPDATE extraction_items SET status = ?, resolution = ?, material_id = ?, updated_at = ${NOW} WHERE id = ?`
    ).run(status, resolution ?? null, materialId ?? null, id);
    return id;
  });
  const archived = run();
  return archived === null ? null : getExtractionItem(db, id);
}

// ---------- 内部 ----------

function toReferenceRecord(row: ReferenceRow): ReferenceRecord {
  return {
    id: row.id,
    title: row.title,
    format: row.format as ReferenceFormat,
    chapterCount: row.chapter_count,
    extractedCount: row.extracted_count,
    pendingItemCount: row.pending_item_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePayload(raw: string): MaterialPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as MaterialPayload;
  } catch {
    // 落库内容均由本模块序列化，防御性兜底
  }
  return {};
}

function toExtractionRecord(db: DB, row: ExtractionRow): ExtractionItemRecord {
  const conflict =
    row.status === 'pending'
      ? findConflictMaterial(db, row.type as MaterialType, row.title)
      : null;
  return {
    id: row.id,
    referenceId: row.reference_id,
    chapterId: row.chapter_id,
    chapterTitle: row.chapter_title,
    type: row.type as MaterialType,
    title: row.title,
    content: row.content,
    payload: parsePayload(row.payload),
    status: row.status as ExtractionStatus,
    resolution: (row.resolution as ExtractionResolution | null) ?? null,
    materialId: row.material_id,
    conflict,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 重名碰撞：全局库中同类型且标题完全一致的素材（仅取最早一条作提示） */
export function findConflictMaterial(db: DB, type: MaterialType, title: string): { materialId: number; title: string } | null {
  const row = db
    .prepare('SELECT id, title FROM materials WHERE type = ? AND title = ? ORDER BY id ASC LIMIT 1')
    .get(type, title) as { id: number; title: string } | undefined;
  return row ? { materialId: row.id, title: row.title } : null;
}
