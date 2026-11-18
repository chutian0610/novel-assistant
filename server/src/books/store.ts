import type { DB } from '../db/open';
import { getMaterial, type MaterialPayload, type MaterialRecord } from '../materials/store';

export interface BookRecord {
  id: number;
  title: string;
  /** 书契约元数据：题材/基调/承诺（CONTEXT.md「书」） */
  genre: string;
  tone: string;
  promise: string;
  materialCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookWriteInput {
  title: string;
  genre: string;
  tone: string;
  promise: string;
}

/** 书内覆写补丁：按键遮蔽全局素材的同名字段，不回写全局库 */
export interface MaterialOverrides {
  title?: string;
  content?: string;
  payload?: MaterialPayload;
}

export interface BookMaterialRecord {
  materialId: number;
  addedAt: string;
  updatedAt: string;
  /** 全局素材实时记录（非快照）：未覆写字段对全局修订即时可见 */
  material: MaterialRecord;
  /** 全局素材 + 覆写补丁合并后的书内生效视图 */
  effective: { title: string; content: string; payload: MaterialPayload };
  /** 被覆写的字段点路径（字典序），如 ['content', 'payload.category'] */
  overriddenFields: string[];
}

interface BookRow {
  id: number;
  title: string;
  genre: string;
  tone: string;
  promise: string;
  material_count: number;
  created_at: string;
  updated_at: string;
}

interface BookMaterialRow {
  book_id: number;
  material_id: number;
  overrides: string;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// ---------- 书：查询 ----------

const BOOK_SELECT = `
  SELECT b.*, (SELECT COUNT(*) FROM book_materials bm WHERE bm.book_id = b.id) AS material_count
  FROM books b`;

export interface BookListFilter {
  limit: number;
  offset: number;
}

export function listBooks(db: DB, filter: BookListFilter): { items: BookRecord[]; total: number } {
  const total = (db.prepare('SELECT COUNT(*) AS count FROM books').get() as { count: number }).count;
  const rows = db
    .prepare(`${BOOK_SELECT} ORDER BY b.updated_at DESC, b.id DESC LIMIT ? OFFSET ?`)
    .all(filter.limit, filter.offset) as BookRow[];
  return { items: rows.map(toBookRecord), total };
}

export function getBook(db: DB, id: number): BookRecord | null {
  const row = db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(id) as BookRow | undefined;
  return row ? toBookRecord(row) : null;
}

// ---------- 书：写入 ----------

export function createBook(db: DB, input: BookWriteInput): BookRecord {
  const info = db
    .prepare('INSERT INTO books (title, genre, tone, promise) VALUES (?, ?, ?, ?)')
    .run(input.title, input.genre, input.tone, input.promise);
  return getBook(db, Number(info.lastInsertRowid))!;
}

export function updateBook(db: DB, id: number, patch: Partial<BookWriteInput>): BookRecord | null {
  const existing = getBook(db, id);
  if (!existing) return null;
  db.prepare(
    `UPDATE books SET title = ?, genre = ?, tone = ?, promise = ?, updated_at = ${NOW} WHERE id = ?`
  ).run(
    patch.title ?? existing.title,
    patch.genre ?? existing.genre,
    patch.tone ?? existing.tone,
    patch.promise ?? existing.promise,
    id
  );
  return getBook(db, id);
}

export function deleteBook(db: DB, id: number): boolean {
  return db.prepare('DELETE FROM books WHERE id = ?').run(id).changes > 0;
}

// ---------- 书内素材引用：查询 ----------

export function listBookMaterials(db: DB, bookId: number): { items: BookMaterialRecord[]; total: number } {
  const rows = db
    .prepare('SELECT * FROM book_materials WHERE book_id = ? ORDER BY created_at DESC, material_id DESC')
    .all(bookId) as BookMaterialRow[];
  return { items: rows.map((row) => toBookMaterialRecord(db, row)), total: rows.length };
}

export function getBookMaterial(db: DB, bookId: number, materialId: number): BookMaterialRecord | null {
  const row = db
    .prepare('SELECT * FROM book_materials WHERE book_id = ? AND material_id = ?')
    .get(bookId, materialId) as BookMaterialRow | undefined;
  return row ? toBookMaterialRecord(db, row) : null;
}

// ---------- 书内素材引用：写入 ----------

/** 书内素材变动视为书的活动：刷新 books.updated_at，书架「更新于」与排序随之反映 */
function touchBook(db: DB, bookId: number): void {
  db.prepare(`UPDATE books SET updated_at = ${NOW} WHERE id = ?`).run(bookId);
}

/** 引用素材进书；已引用（主键冲突）时静默忽略并返回 false，由 API 层映射 409 */
export function insertBookMaterial(db: DB, bookId: number, materialId: number): boolean {
  const run = db.transaction(() => {
    const info = db
      .prepare('INSERT OR IGNORE INTO book_materials (book_id, material_id) VALUES (?, ?)')
      .run(bookId, materialId);
    if (info.changes > 0) touchBook(db, bookId);
    return info.changes > 0;
  });
  return run();
}

/** 用新补丁整体替换覆写（空补丁 = 清除全部覆写回退全局）；引用不存在时返回 null */
export function updateBookMaterial(
  db: DB,
  bookId: number,
  materialId: number,
  overrides: MaterialOverrides
): BookMaterialRecord | null {
  const run = db.transaction(() => {
    const existing = getBookMaterial(db, bookId, materialId);
    if (!existing) return null;
    db.prepare(
      `UPDATE book_materials SET overrides = ?, updated_at = ${NOW} WHERE book_id = ? AND material_id = ?`
    ).run(JSON.stringify(overrides), bookId, materialId);
    touchBook(db, bookId);
    return getBookMaterial(db, bookId, materialId);
  });
  return run();
}

/** 只移除书内引用；全局素材不受影响（无级联回写） */
export function removeBookMaterial(db: DB, bookId: number, materialId: number): boolean {
  const run = db.transaction(() => {
    const info = db
      .prepare('DELETE FROM book_materials WHERE book_id = ? AND material_id = ?')
      .run(bookId, materialId);
    if (info.changes > 0) touchBook(db, bookId);
    return info.changes > 0;
  });
  return run();
}

// ---------- 内部 ----------

function toBookRecord(row: BookRow): BookRecord {
  return {
    id: row.id,
    title: row.title,
    genre: row.genre,
    tone: row.tone,
    promise: row.promise,
    materialCount: row.material_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBookMaterialRecord(db: DB, row: BookMaterialRow): BookMaterialRecord {
  // 引用行随外键级联维护，material 必然存在；防御性跳过损坏行
  const material = getMaterial(db, row.material_id);
  if (!material) throw new Error(`引用 ${row.material_id} 的全局素材缺失（book_materials 与 materials 失同步）`);

  const overrides = parseOverrides(row.overrides);
  const effective = {
    title: overrides.title ?? material.title,
    content: overrides.content ?? material.content,
    payload: { ...material.payload, ...overrides.payload },
  };
  const overriddenFields: string[] = [];
  if (overrides.title !== undefined) overriddenFields.push('title');
  if (overrides.content !== undefined) overriddenFields.push('content');
  for (const key of Object.keys(overrides.payload ?? {})) overriddenFields.push(`payload.${key}`);
  overriddenFields.sort();

  return {
    materialId: row.material_id,
    addedAt: row.created_at,
    updatedAt: row.updated_at,
    material,
    effective,
    overriddenFields,
  };
}

function parseOverrides(raw: string): MaterialOverrides {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    const out: MaterialOverrides = {};
    if (typeof obj.title === 'string') out.title = obj.title;
    if (typeof obj.content === 'string') out.content = obj.content;
    if (obj.payload && typeof obj.payload === 'object' && !Array.isArray(obj.payload)) {
      const payload: MaterialPayload = {};
      for (const [key, value] of Object.entries(obj.payload)) {
        if (typeof value === 'string') payload[key] = value;
      }
      out.payload = payload;
    }
    return out;
  } catch {
    return {};
  }
}
