import { getBook, getBookMaterial, type BookMaterialRecord, type BookRecord } from '../books/store';
import type { DB } from '../db/open';
import { CHARACTER_STATE_CATEGORY_LABELS, listCharacterStates } from '../facts/store';
import { buildRecallQuery } from '../materials/search';
import type { MaterialType } from '../materials/store';
import { getOutlineTree } from '../outlines/store';
import { estimateTokens } from './tokens';

/**
 * 预算装填（T9，CONTEXT.md「注入视图/预算装填」）：为指定章构造实际进入 prompt 的子集。
 * 全量库与注入视图严格分离；本模块只读，不写任何表。
 *
 * 分层与顺序固定：
 *   1. contract   必带——书契约（题材/基调/承诺）
 *   2. outline    必带——该章相关大纲（所属卷纲 + 该章章纲）
 *   3. characters 必带——出场角色运行时（各角色各类目在目标章前的最新状态）
 *   4. relevance  相关——FTS5(BM25) 检索书内引用素材，按相关度选材、按预算截断
 *
 * 关键决策：
 * - 章号 → 章纲：章纲无章号字段，按大纲树顺序（卷序 + 卷内序）取第 N 条；超出范围报错。
 * - 出场角色运行时：写作第 N 章时各角色「此时此刻」= 每角色×类目取 chapter ≤ N 的最新一条
 *   （角色运行时逐章增量语义）；未来章的状态不泄漏，旧状态被新状态取代。
 * - ADR-0002：所有检索/事实条目注入前一律按章节号升序重排；解析不出章节号的排最后。
 * - 必带层永不丢失：预算再小也完整返回（overBudget 标记超额），仅相关性层被截断——
 *   按相关度名次整条取舍、填满即停（截断语义，不取半条、不跳过肥条补瘦条）。
 * - 相关性检索用 OR 召回 + BM25 排序（buildRecallQuery），检索走全局 FTS 索引、
 *   注入用书内覆写后的生效内容（覆写不影响检索索引）。
 */
export const DEFAULT_BUDGET_TOKENS = 8000;

/** 相关性层候选上限：BM25 名次前 200 的素材才进入装填（V1 规模保险丝） */
const RELEVANCE_CANDIDATE_LIMIT = 200;

export type PackingLayerKey = 'contract' | 'outline' | 'characters' | 'relevance';

export interface PackingItem {
  refType: 'book-contract' | 'volume-outline' | 'chapter-outline' | 'character-state' | 'material';
  refId: number | null;
  title: string;
  /** 注入文本（预览展示与后续 prompt 装填共用） */
  text: string;
  tokens: number;
  /** 出处章节号：事实取章号字段，素材解析自出处章文本；用于 ADR-0002 重排 */
  sourceChapter: number | null;
  /** 相关度名次（1 = BM25 最相关）；仅相关性层条目携带 */
  rank?: number;
}

export interface PackingLayer {
  key: PackingLayerKey;
  label: string;
  kind: 'must' | 'relevance';
  items: PackingItem[];
  tokens: number;
  /** 相关性层是否因预算截断 */
  truncated: boolean;
  /** 因预算放下的候选条数 */
  droppedCount: number;
}

export interface InjectionView {
  bookId: number;
  chapter: number;
  budgetTokens: number;
  usedTokens: number;
  /** 必带层不可截断，预算小于必带层时超额为 true */
  overBudget: boolean;
  layers: PackingLayer[];
}

/** 章 N 超出章纲范围（API 层映射 400） */
export class PackingRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackingRangeError';
  }
}

const MATERIAL_TYPE_LABELS: Record<MaterialType, string> = {
  setting: '设定卡',
  trope: '桥段',
  style: '文风样本',
  skeleton: '书骨骼',
};

export interface FlatChapter {
  volumeTitle: string;
  volumeSummary: string;
  chapterOutlineId: number;
  chapterTitle: string;
  chapterSummary: string;
}

/** 构造指定章的注入视图。前提：书存在（API 层先 requireBook） */
export function buildInjectionView(db: DB, bookId: number, chapter: number, budget = DEFAULT_BUDGET_TOKENS): InjectionView {
  const book = getBook(db, bookId);
  if (!book) throw new Error(`书 ${bookId} 不存在（应先由 API 层 404 拦截）`);
  const target = locateChapterOutline(db, bookId, chapter);
  const must = [contractLayer(book), outlineLayer(target), charactersLayer(db, bookId, chapter)];
  // 预算是全视图总账：相关性层只能用必带层之外的剩余额度（必带层永不丢失，额度可为负 → 视为 0）
  const mustTokens = must.reduce((sum, layer) => sum + layer.tokens, 0);
  const relevance = relevanceLayer(db, bookId, target, Math.max(0, budget - mustTokens));
  const layers: PackingLayer[] = [...must, relevance];
  const usedTokens = layers.reduce((sum, layer) => sum + layer.tokens, 0);
  return { bookId, chapter, budgetTokens: budget, usedTokens, overBudget: usedTokens > budget, layers };
}

// ---------- 必带层 ----------

function contractLayer(book: BookRecord): PackingLayer {
  const fields = ([
    ['题材', book.genre],
    ['基调', book.tone],
    ['承诺', book.promise],
  ] as [string, string][]).filter(([, value]) => value.trim() !== '');
  const text = `书名《${book.title}》${fields.length > 0 ? '：' + fields.map(([key, value]) => `${key}=${value}`).join('；') : ''}`;
  return layer('contract', '书契约', 'must', [
    {
      refType: 'book-contract',
      refId: book.id,
      title: book.title,
      text,
      tokens: estimateTokens(text),
      sourceChapter: null,
    },
  ]);
}

function outlineLayer(target: FlatChapter): PackingLayer {
  const volumeItem: PackingItem = {
    refType: 'volume-outline',
    refId: null,
    title: target.volumeTitle,
    text: target.volumeSummary,
    tokens: estimateTokens(target.volumeSummary),
    sourceChapter: null,
  };
  const chapterItem: PackingItem = {
    refType: 'chapter-outline',
    refId: target.chapterOutlineId,
    title: target.chapterTitle,
    text: target.chapterSummary,
    tokens: estimateTokens(target.chapterSummary),
    sourceChapter: null,
  };
  return layer('outline', '本章大纲', 'must', [volumeItem, chapterItem]);
}

function charactersLayer(db: DB, bookId: number, chapter: number): PackingLayer {
  // 逐章增量语义：按（章号，id）升序扫描，章号 ≤ N 的最后一条即最新状态（按角色×类目各留一条）
  const states = [...listCharacterStates(db, bookId)].sort((a, b) => a.chapter - b.chapter || a.id - b.id);
  const latest = new Map<string, typeof states[number]>();
  for (const state of states) {
    if (state.chapter > chapter) break;
    latest.set(`${state.name}\u0000${state.category}`, state);
  }
  const items = [...latest.values()]
    .sort((a, b) => a.chapter - b.chapter || a.id - b.id)
    .map((state): PackingItem => {
      const label = CHARACTER_STATE_CATEGORY_LABELS[state.category];
      const text = `${state.content}（第${state.chapter}章证据：${state.evidence}）`;
      return {
        refType: 'character-state',
        refId: state.id,
        title: `${state.name}·${label}`,
        text,
        tokens: estimateTokens(text),
        sourceChapter: state.chapter,
      };
    });
  return layer('characters', '出场角色运行时', 'must', items);
}

// ---------- 相关性层 ----------

function relevanceLayer(db: DB, bookId: number, target: FlatChapter, allowance: number): PackingLayer {
  const empty = layer('relevance', '相关素材', 'relevance', []);
  // 查询串 = 该章相关大纲文本（卷纲概要 + 章纲标题 + 章纲概要），OR 召回 + BM25 排序
  const matchQuery = buildRecallQuery([target.volumeSummary, target.chapterTitle, target.chapterSummary].join(' '));
  if (!matchQuery) return empty;

  // 只在书内引用素材里召回；rank 为 FTS5 bm25 名次（越小越相关）
  const rows = db
    .prepare(
      `SELECT material_id, rank FROM (
         SELECT bm.material_id AS material_id,
                (SELECT rank FROM materials_fts WHERE materials_fts MATCH ? AND rowid = bm.material_id) AS rank
         FROM book_materials bm WHERE bm.book_id = ?
       ) WHERE rank IS NOT NULL
       ORDER BY rank
       LIMIT ?`
    )
    .all(matchQuery, bookId, RELEVANCE_CANDIDATE_LIMIT) as { material_id: number; rank: number }[];

  // 候选按相关度名次排列，整条预算装填：填满即停（截断语义）；额度是必带层之外的剩余预算
  let used = 0;
  const kept: PackingItem[] = [];
  let rank = 0;
  for (const row of rows) {
    rank += 1;
    const item = materialItem(db, bookId, row.material_id, rank);
    if (used + item.tokens <= allowance) {
      kept.push(item);
      used += item.tokens;
    } else {
      break;
    }
  }
  const droppedCount = rows.length - kept.length;

  // ADR-0002：注入顺序一律按章节号升序重排（选材顺序仍由相关度决定）；解析不出章节号的排最后
  kept.sort((a, b) => compareChapter(a.sourceChapter, b.sourceChapter) || a.rank! - b.rank!);
  return {
    key: 'relevance',
    label: '相关素材',
    kind: 'relevance',
    items: kept,
    tokens: kept.reduce((sum, item) => sum + item.tokens, 0),
    truncated: droppedCount > 0,
    droppedCount,
  };
}

function materialItem(db: DB, bookId: number, materialId: number, rank: number): PackingItem {
  const record = requireBookMaterial(db, bookId, materialId);
  // 注入用书内生效视图（覆写后），溯源与章节号取全局素材出处
  const { effective, material } = record;
  const parts = [effective.content, ...Object.entries(effective.payload).filter(([, value]) => value.trim() !== '').map(([key, value]) => `${key}=${value}`)];
  if (material.source.book.trim() !== '') parts.push(`出处：${material.source.book} ${material.source.chapter}`.trimEnd());
  const text = `【${MATERIAL_TYPE_LABELS[material.type]}】${parts.join('；')}`;
  return {
    refType: 'material',
    refId: material.id,
    title: effective.title,
    text,
    tokens: estimateTokens(text),
    sourceChapter: parseSourceChapter(material.source.chapter),
    rank,
  };
}

// ---------- 内部 ----------

function layer(key: PackingLayerKey, label: string, kind: 'must' | 'relevance', items: PackingItem[]): PackingLayer {
  return {
    key,
    label,
    kind,
    items,
    tokens: items.reduce((sum, item) => sum + item.tokens, 0),
    truncated: false,
    droppedCount: 0,
  };
}

/**
 * 章号 → 章纲：章纲无章号字段（T6 schema），按大纲树顺序（卷序 + 卷内序）取第 N 条。
 * 该顺序即 T10 管线建章时的自然章序。导出供管线 prepare 阶段复用同一映射规则。
 */
export function locateChapterOutline(db: DB, bookId: number, chapter: number): FlatChapter {
  const tree = getOutlineTree(db, bookId);
  const flat: FlatChapter[] = tree.volumes.flatMap((volume) =>
    volume.chapters.map((outline) => ({
      volumeTitle: volume.title,
      volumeSummary: volume.summary,
      chapterOutlineId: outline.id,
      chapterTitle: outline.title,
      chapterSummary: outline.summary,
    }))
  );
  const target = flat[chapter - 1];
  if (!target) throw new PackingRangeError(`章 ${chapter} 超出章纲范围（共 ${flat.length} 章）`);
  return target;
}

/** 出处章文本 → 章节号：认「第N章」与前导数字两种写法；解析不了返回 null（重排时殿后） */
function parseSourceChapter(raw: string): number | null {
  const match = raw.match(/第\s*(\d+)\s*章/) ?? raw.match(/^\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

/** 章节号升序比较，null 殿后 */
function compareChapter(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function requireBookMaterial(db: DB, bookId: number, materialId: number): BookMaterialRecord {
  const record = getBookMaterial(db, bookId, materialId);
  // 候选来自 book_materials 实时查询，引用行必然存在；防御性兜底
  if (!record) throw new Error(`书内引用缺失：book ${bookId} × material ${materialId}`);
  return record;
}
