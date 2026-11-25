import { getBook, getBookMaterial, type BookMaterialRecord, type BookRecord } from '../books/store';
import type { DB } from '../db/open';
import { embeddingSimilarity, embedRouteModel, getMaterialEmbedding } from '../embeddings/store';
import { CHARACTER_STATE_CATEGORY_LABELS, listCharacterStates } from '../facts/store';
import { getAuthorProfileView } from '../profile/store';
import { buildRecallQuery } from '../materials/search';
import type { MaterialType } from '../materials/store';
import { getOutlineTree } from '../outlines/store';
import { getPipelineConfig } from '../pipeline/config';
import { listChapters } from '../pipeline/store';
import { estimateTokens } from './tokens';
import type { LLMProvider } from '../llm/types';

/**
 * 预算装填（T9，CONTEXT.md「注入视图/预算装填」）：为指定章构造实际进入 prompt 的子集。
 * 全量库与注入视图严格分离；本模块只读，不写任何表。
 *
 * 分层与顺序固定：
 *   1. contract        必带——书契约（题材/基调/承诺）
 *   2. authorProfile   必带——作者偏好档案（主题偏好/创作禁区/文风样本引用，全局常驻，T14）
 *   3. outline         必带——该章相关大纲（所属卷纲 + 该章章纲）
 *   4. recentSummaries 必带——前文摘要（近 K 章滚动摘要，0=关闭，T15）
 *   5. characters      必带——出场角色运行时（各角色各类目在目标章前的最新状态）
 *   6. relevance       相关——混合检索书内引用素材，按相关度选材、按预算截断
 *
 * 关键决策：
 * - 章号 → 章纲：章纲无章号字段，按大纲树顺序（卷序 + 卷内序）取第 N 条；超出范围报错。
 * - 前文摘要（T15）：写作第 N 章时带第 N-K..N-1 章的滚动摘要（chapters.summary，正文
 *   的确定性派生物），按章号降序（越近越前）。只装已落稿章；V1 缺口修复——摘要此前
 *   已落库但不进 draft prompt，生成「照章纲盲写」。
 * - 出场角色运行时：写作第 N 章时各角色「此时此刻」= 每角色×类目取 chapter ≤ N 的最新一条
 *   （角色运行时逐章增量语义）；未来章的状态不泄漏，旧状态被新状态取代。
 * - 混合相关性检索（T17）：BM25 与向量余弦双路召回、RRF 融合名次。向量路是**可选增强**
 *   （ADR-0002：只影响排序，不是一致性数据源）——embed 路由未配置或查询嵌入失败时
 *   完全降级回纯 BM25（V1 行为零回归）；向量路只对有当前模型向量的素材生效。
 * - ADR-0002：所有检索/事实条目注入前一律按章节号升序重排；解析不出章节号的排最后。
 * - 必带层永不丢失：预算再小也完整返回（overBudget 标记超额），仅相关性层被截断——
 *   按相关度名次整条取舍、填满即停（截断语义，不取半条、不跳过肥条补瘦条）。
 * - 检索走全局索引（FTS 索引 + doc_embeddings 向量），注入用书内覆写后的生效内容。
 */
export const DEFAULT_BUDGET_TOKENS = 8000;

/** 相关性层候选上限：BM25 名次前 200 的素材才进入装填（V1 规模保险丝） */
const RELEVANCE_CANDIDATE_LIMIT = 200;

/** 向量召回同样只看前 200（与 BM25 候选同规模保险丝） */
const VECTOR_CANDIDATE_LIMIT = 200;

/** RRF 融合常数（业界惯例值，平滑单路名次差异） */
const RRF_K = 60;

export type PackingLayerKey = 'contract' | 'authorProfile' | 'outline' | 'recentSummaries' | 'characters' | 'relevance';

export interface PackingItem {
  refType:
    | 'book-contract'
    | 'author-profile'
    | 'style-sample'
    | 'volume-outline'
    | 'chapter-outline'
    | 'chapter-summary'
    | 'character-state'
    | 'material';
  refId: number | null;
  title: string;
  /** 注入文本（预览展示与后续 prompt 装填共用） */
  text: string;
  tokens: number;
  /** 出处章节号：事实取章号字段，素材解析自出处章文本；用于 ADR-0002 重排 */
  sourceChapter: number | null;
  /** 相关度名次（1 = 最相关；混合装填时为 RRF 融合名次，降级时即 BM25 名次）；仅相关性层条目携带 */
  rank?: number;
  /** BM25 单路名次（仅向量路参与装填时携带，T17） */
  bm25Rank?: number;
  /** 向量余弦单路名次（仅向量路参与装填时携带，T17） */
  vectorRank?: number;
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

/**
 * 构造指定章的注入视图。前提：书存在（API 层先 requireBook）。
 * 相关性层的查询向量化是可选的 LLM 调用（embed 路由可用才发生，失败自动降级 BM25），
 * 因此本函数为 async；必带层构造始终是纯确定性计算。
 */
export async function buildInjectionView(
  db: DB,
  llm: LLMProvider,
  bookId: number,
  chapter: number,
  budget = DEFAULT_BUDGET_TOKENS
): Promise<InjectionView> {
  const book = getBook(db, bookId);
  if (!book) throw new Error(`书 ${bookId} 不存在（应先由 API 层 404 拦截）`);
  const target = locateChapterOutline(db, bookId, chapter);
  const must = [
    contractLayer(book),
    authorProfileLayer(db),
    outlineLayer(target),
    recentSummariesLayer(db, bookId, chapter),
    charactersLayer(db, bookId, chapter),
  ];
  // 预算是全视图总账：相关性层只能用必带层之外的剩余额度（必带层永不丢失，额度可为负 → 视为 0）
  const mustTokens = must.reduce((sum, layer) => sum + layer.tokens, 0);
  const relevance = await relevanceLayer(db, llm, bookId, target, Math.max(0, budget - mustTokens));
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

/** 作者偏好档案层（T14）：主题偏好/创作禁区/文风样本引用，全局常驻必带，空档案时层为空 */
function authorProfileLayer(db: DB): PackingLayer {
  const profile = getAuthorProfileView(db);
  const items: PackingItem[] = [];
  const profileTexts: { title: string; text: string }[] = [
    { title: '主题偏好', text: profile.themePreference.trim() },
    { title: '创作禁区', text: profile.taboos.trim() },
  ];
  for (const { title, text: value } of profileTexts) {
    if (value === '') continue;
    items.push({
      refType: 'author-profile',
      refId: null,
      title,
      text: value,
      tokens: estimateTokens(value),
      sourceChapter: null,
    });
  }
  for (const material of profile.styleSamples) {
    items.push({
      refType: 'style-sample',
      refId: material.id,
      title: material.title,
      text: material.content,
      tokens: estimateTokens(material.content),
      sourceChapter: parseSourceChapter(material.source.chapter),
    });
  }
  return layer('authorProfile', '作者偏好', 'must', items);
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

/**
 * 前文摘要层（T15）：第 N-K..N-1 章的滚动摘要（chapters.summary，正文确定性派生物），
 * 按章号降序（越近越前）。已落稿章才在 chapters 表里，天然不泄漏未来章；
 * K=0（管线预设可关）或目标章为第 1 章时层为空。必带层：预算再小也完整携带。
 */
function recentSummariesLayer(db: DB, bookId: number, chapter: number): PackingLayer {
  const limit = getPipelineConfig(db).recentSummariesLimit;
  if (limit <= 0) return layer('recentSummaries', '前文摘要', 'must', []);
  const prior = listChapters(db, bookId)
    .filter((record) => record.idx < chapter && record.summary.trim() !== '')
    .slice(-limit)
    .reverse();
  const items = prior.map(
    (record): PackingItem => ({
      refType: 'chapter-summary',
      refId: null,
      title: record.title,
      text: `第${record.idx}章：${record.summary}`,
      tokens: estimateTokens(`第${record.idx}章：${record.summary}`),
      sourceChapter: record.idx,
    })
  );
  return layer('recentSummaries', '前文摘要', 'must', items);
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

/** 单路召回的名次表：materialId → 1 起始名次 */
type RankMap = Map<number, number>;

/**
 * 混合相关性检索：BM25 与向量余弦双路召回，RRF 融合名次，按融合名次整条装填。
 * 降级语义：embed 路由未配置 / 查询嵌入失败 / 素材无当前模型向量时，向量路整体缺席，
 * 融合退化为纯 BM25（名次与 V1 逐一相同，行为零回归）。
 */
async function relevanceLayer(db: DB, llm: LLMProvider, bookId: number, target: FlatChapter, allowance: number): Promise<PackingLayer> {
  const empty = layer('relevance', '相关素材', 'relevance', []);
  // 查询串 = 该章相关大纲文本（卷纲概要 + 章纲标题 + 章纲概要）
  const queryText = [target.volumeSummary, target.chapterTitle, target.chapterSummary].join(' ');
  // OR 召回 + BM25 排序（buildRecallQuery 无可分词内容时返回 null → BM25 路缺席）
  const matchQuery = buildRecallQuery(queryText);

  // 路 1：FTS5(BM25)，只在书内引用素材里召回（V1 原样）
  const bm25Ranks: RankMap = new Map();
  if (matchQuery) {
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
    rows.forEach((row, index) => bm25Ranks.set(row.material_id, index + 1));
  }

  // 路 2：向量余弦（T17，可选增强）。查询嵌入失败或路由不可用 → 整路缺席，不阻塞装填。
  // 不设相似度截断：真实嵌入模型对无关文本也给非零余弦，弱相似素材照进名次，
  // 由 RRF 权重随名次衰减 + 预算截断自然沉底（截断从融合名次末尾开始）。
  const vectorRanks: RankMap = new Map();
  const embedModel = embedRouteModel(db);
  if (embedModel !== null && queryText.trim() !== '') {
    try {
      const [queryVector] = (await llm.embed({ texts: [queryText] })).vectors;
      if (queryVector) {
        const referenced = db.prepare('SELECT material_id FROM book_materials WHERE book_id = ? LIMIT ?').all(bookId, VECTOR_CANDIDATE_LIMIT) as {
          material_id: number;
        }[];
        const scored: { materialId: number; similarity: number }[] = [];
        for (const row of referenced) {
          const vector = getMaterialEmbedding(db, row.material_id, embedModel);
          if (!vector) continue; // 缺当前模型向量的素材不参与向量路（失败/未索引的自动跳过）
          scored.push({ materialId: row.material_id, similarity: embeddingSimilarity(queryVector, vector) });
        }
        scored
          .sort((a, b) => b.similarity - a.similarity || a.materialId - b.materialId)
          .forEach((entry, index) => vectorRanks.set(entry.materialId, index + 1));
      }
    } catch {
      // 查询嵌入失败 → 降级纯 BM25（装填永不因增强路失败而失败）
    }
  }
  // 单路名次标注只在向量路真正参与时携带（降级即纯 BM25，标注缺席 = V1 形态）
  const vectorPathUsed = vectorRanks.size > 0;

  // RRF 融合：score = Σ 1/(k+单路名次)；两路全缺的 id 不会出现。融合名次并列时 BM25 优先、再按 id 稳定排序
  const candidateIds = new Set<number>([...bm25Ranks.keys(), ...vectorRanks.keys()]);
  const fused = [...candidateIds]
    .map((materialId) => {
      const bm25Rank = bm25Ranks.get(materialId);
      const vectorRank = vectorRanks.get(materialId);
      let score = 0;
      if (bm25Rank !== undefined) score += 1 / (RRF_K + bm25Rank);
      if (vectorRank !== undefined) score += 1 / (RRF_K + vectorRank);
      return { materialId, bm25Rank, vectorRank, score };
    })
    .sort((a, b) => b.score - a.score || (a.bm25Rank ?? Infinity) - (b.bm25Rank ?? Infinity) || a.materialId - b.materialId)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  // 候选按融合名次排列，整条预算装填：填满即停（截断语义）；额度是必带层之外的剩余预算
  let used = 0;
  const kept: PackingItem[] = [];
  for (const candidate of fused) {
    const item = materialItem(db, bookId, candidate, vectorPathUsed);
    if (used + item.tokens <= allowance) {
      kept.push(item);
      used += item.tokens;
    } else {
      break;
    }
  }
  const droppedCount = fused.length - kept.length;

  // ADR-0002：注入顺序一律按章节号升序重排（选材顺序仍由融合名次决定）；解析不出章节号的排最后
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

function materialItem(
  db: DB,
  bookId: number,
  candidate: { materialId: number; rank: number; bm25Rank?: number; vectorRank?: number },
  vectorPathUsed: boolean
): PackingItem {
  const record = requireBookMaterial(db, bookId, candidate.materialId);
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
    rank: candidate.rank,
    // 单路名次仅在向量路参与装填时携带（透明标注混合来源；降级形态与 V1 全同）
    ...(vectorPathUsed && candidate.bm25Rank !== undefined ? { bm25Rank: candidate.bm25Rank } : {}),
    ...(vectorPathUsed && candidate.vectorRank !== undefined ? { vectorRank: candidate.vectorRank } : {}),
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
