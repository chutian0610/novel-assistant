import type { DB } from '../db/open';
import { buildSearchText, buildMatchQuery } from './search';

// 领域词汇见 CONTEXT.md：素材分四类——设定卡/桥段/文风样本/书骨骼
export const MATERIAL_TYPES = ['setting', 'trope', 'style', 'skeleton'] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];

/** 各类型结构化字段的领域规则（zod schema 在 API 层据此构建；前端 web/src/materialSchema.ts 为镜像表单定义） */
export interface PayloadFieldRule {
  key: string;
  label: string;
  required: boolean;
  maxLength: number;
}

export const PAYLOAD_FIELDS: Record<MaterialType, PayloadFieldRule[]> = {
  setting: [{ key: 'category', label: '领域分类', required: false, maxLength: 100 }],
  trope: [{ key: 'structure', label: '结构要点', required: false, maxLength: 5000 }],
  style: [{ key: 'rhythm', label: '句式节奏说明', required: false, maxLength: 5000 }],
  skeleton: [
    { key: 'pacingCurve', label: '节奏曲线', required: true, maxLength: 10000 },
    { key: 'volumeStructure', label: '卷纲结构', required: true, maxLength: 10000 },
    { key: 'archetypes', label: '人物原型', required: true, maxLength: 10000 },
  ],
};

/** 各类型的结构化字段（schema 在 API 层按类型校验；前端 web/src/materialSchema.ts 为镜像表单定义） */
export type MaterialPayload = Record<string, string>;

/** 素材字段的按键补丁（书内覆写与抽取条目修改共用形状） */
export interface MaterialFieldPatch {
  title?: string;
  content?: string;
  payload?: MaterialPayload;
}

export interface MaterialSource {
  kind: 'manual' | 'reference';
  book: string;
  chapter: string;
}

export interface MaterialRecord {
  id: number;
  type: MaterialType;
  title: string;
  content: string;
  payload: MaterialPayload;
  tags: string[];
  source: MaterialSource;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialWriteInput {
  type: MaterialType;
  title: string;
  content: string;
  payload: MaterialPayload;
  tags: string[];
  source: MaterialSource;
}

export interface MaterialListFilter {
  type?: MaterialType;
  tag?: string;
  /** 用户原始查询串；无可分词内容时忽略该条件 */
  q?: string;
  limit: number;
  offset: number;
}

interface MaterialRow {
  id: number;
  type: string;
  title: string;
  content: string;
  payload: string;
  source_kind: string;
  source_book: string;
  source_chapter: string;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// ---------- 查询 ----------

export function listMaterials(db: DB, filter: MaterialListFilter): { items: MaterialRecord[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filter.type) {
    where.push('m.type = ?');
    params.push(filter.type);
  }

  if (filter.tag) {
    // 明确选择了标签：不存在的标签名返回空集（而非忽略条件）
    where.push('m.id IN (SELECT material_id FROM material_tags WHERE tag_id = (SELECT id FROM tags WHERE name = ?))');
    params.push(filter.tag);
  }

  const matchQuery = filter.q ? buildMatchQuery(filter.q) : null;
  if (matchQuery) {
    where.push('m.id IN (SELECT rowid FROM materials_fts WHERE materials_fts MATCH ?)');
    params.push(matchQuery);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM materials m ${whereClause}`).get(...params) as { count: number }
  ).count;

  const rows = db
    .prepare(`SELECT m.* FROM materials m ${whereClause} ORDER BY m.updated_at DESC, m.id DESC LIMIT ? OFFSET ?`)
    .all(...params, filter.limit, filter.offset) as MaterialRow[];

  return { items: rows.map((row) => toRecord(db, row)), total };
}

export function getMaterial(db: DB, id: number): MaterialRecord | null {
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as MaterialRow | undefined;
  return row ? toRecord(db, row) : null;
}

export function listTags(db: DB): { name: string; count: number }[] {
  return db
    .prepare(
      `SELECT t.name AS name, COUNT(mt.material_id) AS count
       FROM tags t
       JOIN material_tags mt ON mt.tag_id = t.id
       GROUP BY t.id
       ORDER BY count DESC, t.name ASC`
    )
    .all() as { name: string; count: number }[];
}

// ---------- 写入 ----------

export function createMaterial(db: DB, input: MaterialWriteInput): MaterialRecord {
  const insert = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO materials (type, title, content, payload, source_kind, source_book, source_chapter, search_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.type,
        input.title,
        input.content,
        JSON.stringify(input.payload),
        input.source.kind,
        input.source.book,
        input.source.chapter,
        buildSearchTextFor(input)
      );
    const id = Number(info.lastInsertRowid);
    syncTags(db, id, input.tags);
    return id;
  });
  const id = insert();
  return getMaterial(db, id)!;
}

export function updateMaterial(db: DB, id: number, patch: Partial<MaterialWriteInput>): MaterialRecord | null {
  const existing = getMaterial(db, id);
  if (!existing) return null;

  const next: MaterialWriteInput = {
    type: existing.type, // 类型创建后不可变（payload schema 与类型绑定）
    title: patch.title ?? existing.title,
    content: patch.content ?? existing.content,
    payload: patch.payload ?? existing.payload,
    tags: patch.tags ?? existing.tags,
    source: patch.source ?? existing.source,
  };

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE materials
       SET title = ?, content = ?, payload = ?, source_kind = ?, source_book = ?, source_chapter = ?,
           search_text = ?, updated_at = ${NOW}
       WHERE id = ?`
    ).run(
      next.title,
      next.content,
      JSON.stringify(next.payload),
      next.source.kind,
      next.source.book,
      next.source.chapter,
      buildSearchTextFor(next),
      id
    );
    if (patch.tags !== undefined) syncTags(db, id, patch.tags);
  });
  run();

  return getMaterial(db, id);
}

export function deleteMaterial(db: DB, id: number): boolean {
  const run = db.transaction(() => {
    const info = db.prepare('DELETE FROM materials WHERE id = ?').run(id);
    pruneOrphanTags(db);
    return info.changes > 0;
  });
  return run();
}

// ---------- 内部 ----------

function buildSearchTextFor(input: MaterialWriteInput): string {
  return buildSearchText([
    input.title,
    input.content,
    ...Object.values(input.payload),
    input.tags.join(' '),
    input.source.book,
    input.source.chapter,
  ]);
}

/** 把素材的标签集合同步进 tags / material_tags（事务内调用） */
function syncTags(db: DB, materialId: number, names: string[]): void {
  const unique = [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))];
  db.prepare('DELETE FROM material_tags WHERE material_id = ?').run(materialId);
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const insertJoin = db.prepare('INSERT INTO material_tags (material_id, tag_id) VALUES (?, ?)');
  for (const name of unique) {
    insertTag.run(name);
    const tag = findTag.get(name) as { id: number };
    insertJoin.run(materialId, tag.id);
  }
  pruneOrphanTags(db);
}

/** 清理不再被任何素材引用的标签 */
function pruneOrphanTags(db: DB): void {
  db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM material_tags)').run();
}

function toRecord(db: DB, row: MaterialRow): MaterialRecord {
  const tags = db
    .prepare(
      `SELECT t.name FROM tags t JOIN material_tags mt ON mt.tag_id = t.id
       WHERE mt.material_id = ? ORDER BY t.name ASC`
    )
    .all(row.id) as { name: string }[];
  let payload: MaterialPayload = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as MaterialPayload;
    }
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    type: row.type as MaterialType,
    title: row.title,
    content: row.content,
    payload,
    tags: tags.map((tag) => tag.name),
    source: { kind: row.source_kind as MaterialSource['kind'], book: row.source_book, chapter: row.source_chapter },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
