import type { DB } from '../db/open';
import { embeddingSimilarity, embedRouteModel } from '../embeddings/store';
import { splitChapterBlocks } from './blocks';
import type { LLMProvider } from '../llm/types';
import { getPipelineConfig } from '../pipeline/config';
import { getChapterId, listChapters } from '../pipeline/store';

/**
 * 跨章情节自相似扫描（T20）：全书正文块两两余弦（归一化点积），应用层暴力算。
 *
 * 过滤规则（顺序即语义）：
 * - 只比**有当前模型向量**的块（stale/缺失章整体缺席）；
 * - |章差| < 排除窗口的对不报（情节自然延续、同章推进是常态，不是自抄袭）；
 * - 相似度 < 阈值的对不报；按相似度降序只取 top-K。
 *
 * 量级保险丝：目标 10³~10⁴ 块（数十万字书 ≈ 数千块），O(n²) 暴力在秒级；
 * 超出量级时应先分卷/分段扫描（V3 不做，见 spec Out of Scope）。
 */

export interface SimilarPair {
  aIdx: number;
  aChunk: number;
  aExcerpt: string;
  bIdx: number;
  bChunk: number;
  bExcerpt: string;
  similarity: number;
}

export interface SimilarityReport {
  /** 相似对（相似度降序，最多 topK 条） */
  items: SimilarPair[];
  /** 参与扫描的章数 / 块数（空态展示用：0 = 无可用向量） */
  scannedChapters: number;
  scannedBlocks: number;
  /** 扫描所用嵌入模型（null = 无可用向量） */
  model: string | null;
}

/** 段摘长度（报告展示用截断，原文在写作台定位） */
export const EXCERPT_CHARS = 40;

export interface ScannedBlock {
  idx: number;
  chunkIndex: number;
  text: string;
  vector: number[];
}

/**
 * 组装扫描集：按章取当前模型向量（chunk_index → 向量），与确定性切块逐块对齐；
 * 向量覆盖不全的章整体跳过（内容变过而向量没跟上 = 数据不完整，不报半章）。
 * 自相似报告（T20）与呼应检索（T21）共用。
 */
export function collectChapterBlocks(db: DB, bookId: number, model: string): { blocks: ScannedBlock[]; scannedChapters: number } {
  const chapters = listChapters(db, bookId);
  const blocks: ScannedBlock[] = [];
  let scannedChapters = 0;
  for (const chapter of chapters) {
    const chapterId = getChapterId(db, bookId, chapter.idx);
    if (chapterId === null) continue;
    const rows = db
      .prepare(
        `SELECT chunk_index, vector FROM doc_embeddings
         WHERE entity_type = 'chapter_block' AND entity_id = ? AND model = ?
         ORDER BY chunk_index`
      )
      .all(chapterId, model) as { chunk_index: number; vector: Buffer }[];
    if (rows.length === 0) continue;
    const vectorsByChunk = new Map(rows.map((row) => [row.chunk_index, row.vector]));
    const chapterBlocks = splitChapterBlocks(chapter.content);
    if (chapterBlocks.some((block) => !vectorsByChunk.has(block.index))) continue;
    scannedChapters += 1;
    for (const block of chapterBlocks) {
      const blob = vectorsByChunk.get(block.index)!;
      const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
      blocks.push({ idx: chapter.idx, chunkIndex: block.index, text: block.text, vector: Array.from(floats) });
    }
  }
  return { blocks, scannedChapters };
}

export function findSimilarPairs(db: DB, bookId: number): SimilarityReport {
  const { similarityExcludeWindow, similarityThreshold, similarityTopK } = getPipelineConfig(db);
  const model = embedRouteModel(db);
  if (!model) return { items: [], scannedChapters: 0, scannedBlocks: 0, model: null };

  const { blocks, scannedChapters } = collectChapterBlocks(db, bookId, model);

  // 两两比相似度：i<j 全组合，窗口外 + 过阈值的对入候选
  const candidates: SimilarPair[] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]!;
      const b = blocks[j]!;
      if (Math.abs(a.idx - b.idx) < similarityExcludeWindow) continue;
      const similarity = embeddingSimilarity(a.vector, b.vector);
      if (similarity < similarityThreshold) continue;
      candidates.push({
        aIdx: a.idx,
        aChunk: a.chunkIndex,
        aExcerpt: a.text.slice(0, EXCERPT_CHARS),
        bIdx: b.idx,
        bChunk: b.chunkIndex,
        bExcerpt: b.text.slice(0, EXCERPT_CHARS),
        similarity,
      });
    }
  }
  candidates.sort((x, y) => y.similarity - x.similarity || x.aIdx - y.aIdx || x.bIdx - y.bIdx);
  return {
    items: candidates.slice(0, similarityTopK),
    scannedChapters,
    scannedBlocks: blocks.length,
    model,
  };
}

// ---------- 呼应检索（T21） ----------

export interface EchoSearchItem {
  idx: number;
  chunk: number;
  excerpt: string;
  similarity: number;
}

export interface EchoSearchResult {
  model: string;
  items: EchoSearchItem[];
}

/**
 * 呼应检索：查询文本 → 向量 → 全书正文块 top-K（相似度降序）。
 * excludeIdx 用于排除当前章自身（写作台在章内检索时不应搜到自己）。
 */
export async function searchChapterBlocks(
  db: DB,
  llm: LLMProvider,
  bookId: number,
  options: { query: string; excludeIdx?: number; topK: number }
): Promise<EchoSearchResult> {
  const model = embedRouteModel(db);
  if (!model) throw new Error('embed 路由未配置（应由 API 层先映射 409）');
  const [queryVector] = (await llm.embed({ texts: [options.query] })).vectors;
  if (!queryVector) return { model, items: [] };
  const { blocks } = collectChapterBlocks(db, bookId, model);
  const items: EchoSearchItem[] = [];
  for (const block of blocks) {
    if (options.excludeIdx !== undefined && block.idx === options.excludeIdx) continue;
    items.push({
      idx: block.idx,
      chunk: block.chunkIndex,
      excerpt: block.text.slice(0, EXCERPT_CHARS),
      similarity: embeddingSimilarity(queryVector, block.vector),
    });
  }
  items.sort((x, y) => y.similarity - x.similarity || x.idx - y.idx || x.chunk - y.chunk);
  return { model, items: items.slice(0, options.topK) };
}
