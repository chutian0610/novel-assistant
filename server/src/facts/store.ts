import type { DB } from '../db/open';

/**
 * 事实系统存储层（ADR-0002）：事实的正确形态是「带时序的行」——
 * 四张结构化表全部挂书，每条事实带来源章（chapter）+ 原文证据（evidence）供审计。
 * 人工 CRUD 与落稿自动回灌（T12）并存：origin 标记来源（manual/auto），
 * 回灌只整章替换本章 auto 行，人工事实不受影响；每条事实带来源章（chapter）+ 原文证据（evidence）供审计。
 */

// ---------- 角色运行时 ----------

export const CHARACTER_STATE_CATEGORIES = ['injury', 'secret', 'possession', 'realm', 'other'] as const;
export type CharacterStateCategory = (typeof CHARACTER_STATE_CATEGORIES)[number];

export const CHARACTER_STATE_CATEGORY_LABELS: Record<CharacterStateCategory, string> = {
  injury: '伤势',
  secret: '秘密',
  possession: '持有物',
  realm: '境界',
  other: '其他',
};

export type FactOrigin = 'auto' | 'manual';

export interface CharacterStateRecord {
  id: number;
  bookId: number;
  /** 角色名（V1 以名字为角色键，角色静态设定在素材库设定卡中） */
  name: string;
  /** 来源章：该状态在何章成立 */
  chapter: number;
  category: CharacterStateCategory;
  content: string;
  /** 原文证据 */
  evidence: string;
  /** 来源：落稿回灌（auto）或人工维护（manual） */
  origin: FactOrigin;
  createdAt: string;
  updatedAt: string;
}

// ---------- 人物关系 ----------

export interface CharacterRelationRecord {
  id: number;
  bookId: number;
  /** 有向边：from → to */
  fromName: string;
  toName: string;
  relation: string;
  chapter: number;
  evidence: string;
  origin: FactOrigin;
  createdAt: string;
  updatedAt: string;
}

// ---------- 时间轴 ----------

export interface TimelineEventRecord {
  id: number;
  bookId: number;
  chapter: number;
  title: string;
  content: string;
  evidence: string;
  origin: FactOrigin;
  createdAt: string;
  updatedAt: string;
}

// ---------- 伏笔账本 ----------

export const FORESHADOW_STATUSES = ['planted', 'progressing', 'resolved', 'abandoned'] as const;
export type ForeshadowStatus = (typeof FORESHADOW_STATUSES)[number];

export const FORESHADOW_STATUS_LABELS: Record<ForeshadowStatus, string> = {
  planted: '已埋设',
  progressing: '推进中',
  resolved: '已回收',
  abandoned: '已放弃',
};

export interface ForeshadowRecord {
  id: number;
  bookId: number;
  title: string;
  content: string;
  status: ForeshadowStatus;
  /** 埋设章 */
  plantedChapter: number;
  /** 目标章：超过此章仍未回收即预警 */
  targetChapter: number;
  evidence: string;
  origin: FactOrigin;
  createdAt: string;
  updatedAt: string;
}

/** 伏笔视图 = 账本记录 + 预警标志（指定当前章时判定） */
export interface ForeshadowView extends ForeshadowRecord {
  /** 当前章超过目标章且未回收（planted/progressing）时为 true，面板红色预警 */
  overdue: boolean;
}

/** 非法伏笔状态迁移（API 层映射 409） */
export class ForeshadowTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForeshadowTransitionError';
  }
}

/** 合法迁移表：planted 可推进/回收/放弃，progressing 只可回收/放弃，resolved 与 abandoned 为终态 */
const LEGAL_FORESHADOW_TRANSITIONS: Record<ForeshadowStatus, readonly ForeshadowStatus[]> = {
  planted: ['progressing', 'resolved', 'abandoned'],
  progressing: ['resolved', 'abandoned'],
  resolved: [],
  abandoned: [],
};

interface CharacterStateRow {
  id: number;
  book_id: number;
  name: string;
  chapter: number;
  category: CharacterStateCategory;
  content: string;
  evidence: string;
  origin: FactOrigin;
  created_at: string;
  updated_at: string;
}

interface CharacterRelationRow {
  id: number;
  book_id: number;
  from_name: string;
  to_name: string;
  relation: string;
  chapter: number;
  evidence: string;
  origin: FactOrigin;
  created_at: string;
  updated_at: string;
}

interface TimelineEventRow {
  id: number;
  book_id: number;
  chapter: number;
  title: string;
  content: string;
  evidence: string;
  origin: FactOrigin;
  created_at: string;
  updated_at: string;
}

interface ForeshadowRow {
  id: number;
  book_id: number;
  title: string;
  content: string;
  status: ForeshadowStatus;
  planted_chapter: number;
  target_chapter: number;
  evidence: string;
  origin: FactOrigin;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// ---------- 角色运行时：查询 ----------

export function listCharacterStates(db: DB, bookId: number): CharacterStateRecord[] {
  const rows = db
    .prepare('SELECT * FROM character_states WHERE book_id = ? ORDER BY name, chapter DESC, id DESC')
    .all(bookId) as CharacterStateRow[];
  return rows.map(toCharacterStateRecord);
}

export function getCharacterState(db: DB, bookId: number, id: number): CharacterStateRecord | null {
  const row = db.prepare('SELECT * FROM character_states WHERE book_id = ? AND id = ?').get(bookId, id) as CharacterStateRow | undefined;
  return row ? toCharacterStateRecord(row) : null;
}

// ---------- 角色运行时：写入 ----------

export interface CharacterStateInput {
  name: string;
  chapter: number;
  category: CharacterStateCategory;
  content: string;
  evidence: string;
}

export function createCharacterState(db: DB, bookId: number, input: CharacterStateInput): CharacterStateRecord | null {
  if (!bookExists(db, bookId)) return null;
  const info = db
    .prepare('INSERT INTO character_states (book_id, name, chapter, category, content, evidence) VALUES (?, ?, ?, ?, ?, ?)')
    .run(bookId, input.name, input.chapter, input.category, input.content, input.evidence);
  return getCharacterState(db, bookId, Number(info.lastInsertRowid));
}

export function updateCharacterState(
  db: DB,
  bookId: number,
  id: number,
  patch: Partial<CharacterStateInput>
): CharacterStateRecord | null {
  const existing = getCharacterState(db, bookId, id);
  if (!existing) return null;
  db.prepare(
    `UPDATE character_states SET name = ?, chapter = ?, category = ?, content = ?, evidence = ?, updated_at = ${NOW} WHERE id = ?`
  ).run(
    patch.name ?? existing.name,
    patch.chapter ?? existing.chapter,
    patch.category ?? existing.category,
    patch.content ?? existing.content,
    patch.evidence ?? existing.evidence,
    id
  );
  return getCharacterState(db, bookId, id);
}

export function deleteCharacterState(db: DB, bookId: number, id: number): boolean {
  return db.prepare('DELETE FROM character_states WHERE book_id = ? AND id = ?').run(bookId, id).changes > 0;
}

// ---------- 人物关系：查询 ----------

export function listCharacterRelations(db: DB, bookId: number): CharacterRelationRecord[] {
  const rows = db
    .prepare('SELECT * FROM character_relations WHERE book_id = ? ORDER BY from_name, to_name, id')
    .all(bookId) as CharacterRelationRow[];
  return rows.map(toCharacterRelationRecord);
}

export function getCharacterRelation(db: DB, bookId: number, id: number): CharacterRelationRecord | null {
  const row = db
    .prepare('SELECT * FROM character_relations WHERE book_id = ? AND id = ?')
    .get(bookId, id) as CharacterRelationRow | undefined;
  return row ? toCharacterRelationRecord(row) : null;
}

// ---------- 人物关系：写入 ----------

export interface CharacterRelationInput {
  fromName: string;
  toName: string;
  relation: string;
  chapter: number;
  evidence: string;
}

export function createCharacterRelation(db: DB, bookId: number, input: CharacterRelationInput): CharacterRelationRecord | null {
  if (!bookExists(db, bookId)) return null;
  const info = db
    .prepare('INSERT INTO character_relations (book_id, from_name, to_name, relation, chapter, evidence) VALUES (?, ?, ?, ?, ?, ?)')
    .run(bookId, input.fromName, input.toName, input.relation, input.chapter, input.evidence);
  return getCharacterRelation(db, bookId, Number(info.lastInsertRowid));
}

export function updateCharacterRelation(
  db: DB,
  bookId: number,
  id: number,
  patch: Partial<CharacterRelationInput>
): CharacterRelationRecord | null {
  const existing = getCharacterRelation(db, bookId, id);
  if (!existing) return null;
  db.prepare(
    `UPDATE character_relations SET from_name = ?, to_name = ?, relation = ?, chapter = ?, evidence = ?, updated_at = ${NOW} WHERE id = ?`
  ).run(
    patch.fromName ?? existing.fromName,
    patch.toName ?? existing.toName,
    patch.relation ?? existing.relation,
    patch.chapter ?? existing.chapter,
    patch.evidence ?? existing.evidence,
    id
  );
  return getCharacterRelation(db, bookId, id);
}

export function deleteCharacterRelation(db: DB, bookId: number, id: number): boolean {
  return db.prepare('DELETE FROM character_relations WHERE book_id = ? AND id = ?').run(bookId, id).changes > 0;
}

// ---------- 时间轴：查询 ----------

export function listTimelineEvents(db: DB, bookId: number): TimelineEventRecord[] {
  const rows = db
    .prepare('SELECT * FROM timeline_events WHERE book_id = ? ORDER BY chapter, id')
    .all(bookId) as TimelineEventRow[];
  return rows.map(toTimelineEventRecord);
}

export function getTimelineEvent(db: DB, bookId: number, id: number): TimelineEventRecord | null {
  const row = db.prepare('SELECT * FROM timeline_events WHERE book_id = ? AND id = ?').get(bookId, id) as TimelineEventRow | undefined;
  return row ? toTimelineEventRecord(row) : null;
}

// ---------- 时间轴：写入 ----------

export interface TimelineEventInput {
  chapter: number;
  title: string;
  content: string;
  evidence: string;
}

export function createTimelineEvent(db: DB, bookId: number, input: TimelineEventInput): TimelineEventRecord | null {
  if (!bookExists(db, bookId)) return null;
  const info = db
    .prepare('INSERT INTO timeline_events (book_id, chapter, title, content, evidence) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, input.chapter, input.title, input.content, input.evidence);
  return getTimelineEvent(db, bookId, Number(info.lastInsertRowid));
}

export function updateTimelineEvent(
  db: DB,
  bookId: number,
  id: number,
  patch: Partial<TimelineEventInput>
): TimelineEventRecord | null {
  const existing = getTimelineEvent(db, bookId, id);
  if (!existing) return null;
  db.prepare(
    `UPDATE timeline_events SET chapter = ?, title = ?, content = ?, evidence = ?, updated_at = ${NOW} WHERE id = ?`
  ).run(patch.chapter ?? existing.chapter, patch.title ?? existing.title, patch.content ?? existing.content, patch.evidence ?? existing.evidence, id);
  return getTimelineEvent(db, bookId, id);
}

export function deleteTimelineEvent(db: DB, bookId: number, id: number): boolean {
  return db.prepare('DELETE FROM timeline_events WHERE book_id = ? AND id = ?').run(bookId, id).changes > 0;
}

// ---------- 伏笔账本：查询 ----------

export function listForeshadows(db: DB, bookId: number, currentChapter?: number): ForeshadowView[] {
  const rows = db
    .prepare('SELECT * FROM foreshadows WHERE book_id = ? ORDER BY planted_chapter, id')
    .all(bookId) as ForeshadowRow[];
  return rows.map((row) => {
    const record = toForeshadowRecord(row);
    return { ...record, overdue: isOverdue(record, currentChapter) };
  });
}

export function getForeshadow(db: DB, bookId: number, id: number): ForeshadowRecord | null {
  const row = db.prepare('SELECT * FROM foreshadows WHERE book_id = ? AND id = ?').get(bookId, id) as ForeshadowRow | undefined;
  return row ? toForeshadowRecord(row) : null;
}

/** 超期判定：仅未回收（planted/progressing）且当前章严格大于目标章 */
export function isOverdue(record: ForeshadowRecord, currentChapter?: number): boolean {
  if (currentChapter === undefined) return false;
  const unsettled = record.status === 'planted' || record.status === 'progressing';
  return unsettled && currentChapter > record.targetChapter;
}

// ---------- 伏笔账本：写入 ----------

export interface ForeshadowInput {
  title: string;
  content: string;
  plantedChapter: number;
  targetChapter: number;
  evidence: string;
}

export function createForeshadow(db: DB, bookId: number, input: ForeshadowInput): ForeshadowRecord | null {
  if (!bookExists(db, bookId)) return null;
  const info = db
    .prepare('INSERT INTO foreshadows (book_id, title, content, planted_chapter, target_chapter, evidence) VALUES (?, ?, ?, ?, ?, ?)')
    .run(bookId, input.title, input.content, input.plantedChapter, input.targetChapter, input.evidence);
  return getForeshadow(db, bookId, Number(info.lastInsertRowid));
}

/** 编辑账本条目（状态不走此入口，见 transitionForeshadowStatus） */
export function updateForeshadow(db: DB, bookId: number, id: number, patch: Partial<ForeshadowInput>): ForeshadowRecord | null {
  const existing = getForeshadow(db, bookId, id);
  if (!existing) return null;
  db.prepare(
    `UPDATE foreshadows SET title = ?, content = ?, planted_chapter = ?, target_chapter = ?, evidence = ?, updated_at = ${NOW} WHERE id = ?`
  ).run(
    patch.title ?? existing.title,
    patch.content ?? existing.content,
    patch.plantedChapter ?? existing.plantedChapter,
    patch.targetChapter ?? existing.targetChapter,
    patch.evidence ?? existing.evidence,
    id
  );
  return getForeshadow(db, bookId, id);
}

export function deleteForeshadow(db: DB, bookId: number, id: number): boolean {
  return db.prepare('DELETE FROM foreshadows WHERE book_id = ? AND id = ?').run(bookId, id).changes > 0;
}

/** 伏笔状态流转（唯一入口）；resolved 与 abandoned 为终态，一切回退/同态被拒 */
export function transitionForeshadowStatus(
  db: DB,
  bookId: number,
  id: number,
  to: ForeshadowStatus
): ForeshadowRecord | null {
  const existing = getForeshadow(db, bookId, id);
  if (!existing) return null;
  const from = existing.status;
  if (!LEGAL_FORESHADOW_TRANSITIONS[from].includes(to)) {
    throw new ForeshadowTransitionError(
      `伏笔「${existing.title}」不允许从「${FORESHADOW_STATUS_LABELS[from]}」流转到「${FORESHADOW_STATUS_LABELS[to]}」` +
        '（合法流转：已埋设→推进中→已回收；推进中/已埋设均可放弃；已回收与已放弃为终态）'
    );
  }
  db.prepare(`UPDATE foreshadows SET status = ?, updated_at = ${NOW} WHERE id = ?`).run(to, id);
  return getForeshadow(db, bookId, id);
}

// ---------- 内部 ----------

function bookExists(db: DB, bookId: number): boolean {
  return !!db.prepare('SELECT id FROM books WHERE id = ?').get(bookId);
}

function toCharacterStateRecord(row: CharacterStateRow): CharacterStateRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    name: row.name,
    chapter: row.chapter,
    category: row.category,
    content: row.content,
    evidence: row.evidence,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCharacterRelationRecord(row: CharacterRelationRow): CharacterRelationRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    fromName: row.from_name,
    toName: row.to_name,
    relation: row.relation,
    chapter: row.chapter,
    evidence: row.evidence,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTimelineEventRecord(row: TimelineEventRow): TimelineEventRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    chapter: row.chapter,
    title: row.title,
    content: row.content,
    evidence: row.evidence,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toForeshadowRecord(row: ForeshadowRow): ForeshadowRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    title: row.title,
    content: row.content,
    status: row.status,
    plantedChapter: row.planted_chapter,
    targetChapter: row.target_chapter,
    evidence: row.evidence,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- 落稿回灌（T12）：同章 auto 事实整章替换，幂等 ----------

export interface ExtractedState {
  name: string;
  category: CharacterStateCategory;
  content: string;
  evidence: string;
}

export interface ExtractedRelation {
  fromName: string;
  toName: string;
  relation: string;
  evidence: string;
}

export interface ExtractedTimeline {
  title: string;
  content: string;
  evidence: string;
}

export interface ExtractedForeshadow {
  title: string;
  content: string;
  targetChapter: number;
  evidence: string;
}

export interface ExtractedFacts {
  characterStates: ExtractedState[];
  relations: ExtractedRelation[];
  timeline: ExtractedTimeline[];
  foreshadows: ExtractedForeshadow[];
}

/** 正文被编辑/回退后清除本章回灌事实（旧稿证据已失效）；伏笔账本不随正文删除，由作者在账本中维护 */
export function deleteAutoFacts(db: DB, bookId: number, idx: number): void {
  const run = db.transaction(() => {
    db.prepare("DELETE FROM character_states WHERE book_id = ? AND chapter = ? AND origin = 'auto'").run(bookId, idx);
    db.prepare("DELETE FROM character_relations WHERE book_id = ? AND chapter = ? AND origin = 'auto'").run(bookId, idx);
    db.prepare("DELETE FROM timeline_events WHERE book_id = ? AND chapter = ? AND origin = 'auto'").run(bookId, idx);
  });
  run();
}

export interface FactSyncCounts {
  states: number;
  relations: number;
  timeline: number;
  /** 新登记的伏笔数（同章同名伏笔已存在时跳过，账本状态不被回灌覆盖） */
  foreshadows: number;
}

/**
 * 把第 idx 章的提取结果回灌进四表（单事务）：
 * - 角色运行时/关系/时间轴：删除本章 auto 行后整章重插（重复 commit 幂等，人工行不动）；
 * - 伏笔：按（埋设章，标题）去重后插入 planted——已存在（含人工登记或已推进状态）即跳过，
 *   账本的状态机推进不被回灌覆盖。
 */
export function replaceAutoFacts(db: DB, bookId: number, idx: number, extracted: ExtractedFacts): FactSyncCounts {
  const run = db.transaction((): FactSyncCounts => {
    db.prepare("DELETE FROM character_states WHERE book_id = ? AND chapter = ? AND origin = 'auto'").run(bookId, idx);
    db.prepare("DELETE FROM character_relations WHERE book_id = ? AND chapter = ? AND origin = 'auto'").run(bookId, idx);
    db.prepare("DELETE FROM timeline_events WHERE book_id = ? AND chapter = ? AND origin = 'auto'").run(bookId, idx);

    const insertState = db.prepare(
      "INSERT INTO character_states (book_id, name, chapter, category, content, evidence, origin) VALUES (?, ?, ?, ?, ?, ?, 'auto')"
    );
    for (const state of extracted.characterStates) {
      insertState.run(bookId, state.name, idx, state.category, state.content, state.evidence);
    }

    const insertRelation = db.prepare(
      "INSERT INTO character_relations (book_id, from_name, to_name, relation, chapter, evidence, origin) VALUES (?, ?, ?, ?, ?, ?, 'auto')"
    );
    for (const relation of extracted.relations) {
      insertRelation.run(bookId, relation.fromName, relation.toName, relation.relation, idx, relation.evidence);
    }

    const insertTimeline = db.prepare(
      "INSERT INTO timeline_events (book_id, chapter, title, content, evidence, origin) VALUES (?, ?, ?, ?, ?, 'auto')"
    );
    for (const event of extracted.timeline) {
      insertTimeline.run(bookId, idx, event.title, event.content, event.evidence);
    }

    const foreshadowExists = db.prepare(
      'SELECT id FROM foreshadows WHERE book_id = ? AND planted_chapter = ? AND title = ?'
    );
    const insertForeshadow = db.prepare(
      "INSERT INTO foreshadows (book_id, title, content, status, planted_chapter, target_chapter, evidence, origin) VALUES (?, ?, ?, 'planted', ?, ?, ?, 'auto')"
    );
    let foreshadowCount = 0;
    for (const foreshadow of extracted.foreshadows) {
      if (foreshadowExists.get(bookId, idx, foreshadow.title)) continue;
      insertForeshadow.run(bookId, foreshadow.title, foreshadow.content, idx, foreshadow.targetChapter, foreshadow.evidence);
      foreshadowCount += 1;
    }

    return {
      states: extracted.characterStates.length,
      relations: extracted.relations.length,
      timeline: extracted.timeline.length,
      foreshadows: foreshadowCount,
    };
  });
  return run();
}
