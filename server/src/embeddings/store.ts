import type { DB } from '../db/open';
import { splitChapterBlocks } from '../chapterblocks/blocks';
import { resolveRoute } from '../llm/resolver';
import type { LLMProvider } from '../llm/types';
import { getChapter, getChapterId, listChapters } from '../pipeline/store';
import { getMaterial, type MaterialRecord } from '../materials/store';

/**
 * 向量索引（T16，ADR-0002：embedding 只是装填排序的增强，不是一致性的数据源）。
 * doc_embeddings 的唯一访问层：entity_type = material（素材全局内容）| chapter_block（正文章块，T19）。
 *
 * 关键决策：
 * - 索引对象是素材的**全局内容**（与 FTS 同口径：检索走全局索引，注入用书内覆写后的生效内容）。
 * - 向量 L2 归一化后落 BLOB（Float32Array），余弦退化为点积；维度从嵌入服务响应读取
 *   （ollama 本地模型 768/1024 各不相同，不手动配置）。
 * - model 进行：不同嵌入模型的向量永不混比；换模型后旧行成为 stale，由 reindex 补齐。
 * - embedding 失败不阻塞写路径：索引失败只返回错误信息，素材照常入库 / 章节照常提交；
 *   查询侧只对有当前 model 向量的条目生效，自动跳过缺失项。
 * - 级联为应用层 hook（v17 起 doc_embeddings 无外键）：素材删除（materials API）、
 *   删书（books API）、章节重灌整章替换（本模块 replace 语义）。
 */

/** 重索引时每批送入 /embeddings 的文本数（控制单请求体积） */
export const EMBED_BATCH_SIZE = 16;

export interface EmbeddingSyncResult {
  ok: boolean;
  model?: string;
  error?: string;
}

/** 当前 embed 路由的生效模型；路由未配置返回 null（索引与查询都视为不可用） */
export function embedRouteModel(db: DB): string | null {
  return resolveRoute(db, 'embed')?.model ?? null;
}

/** 素材的向量索引文本：标题 + 正文 + payload 字段 + 标签（与 FTS search_text 同素材口径） */
export function materialEmbedText(record: MaterialRecord): string {
  const parts = [record.title, record.content, ...Object.entries(record.payload).map(([, value]) => value), ...record.tags];
  return parts.filter((part) => part.trim() !== '').join('\n');
}

/** number[] → Float32Array BLOB（SQLite 无向量类型，定长小端浮点是最稳的落盘形态） */
function vectorToBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function blobToVector(blob: Buffer): number[] {
  const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(floats);
}

/** L2 归一化；零向量原样返回（余弦恒 0，不参与相似命中） */
function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

/** 归一化向量的相似度 = 点积（未归一化的调用方应先 normalize）；维度不一致返回 0 */
export function embeddingSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

interface EmbeddingRow {
  vector: Buffer;
  model: string;
  dim: number;
}

/** 读单条素材在指定模型下的向量；无行或模型不匹配返回 null（stale 视同缺失） */
export function getMaterialEmbedding(db: DB, materialId: number, model: string): number[] | null {
  const row = db
    .prepare('SELECT vector, model, dim FROM doc_embeddings WHERE entity_type = ? AND entity_id = ? AND chunk_index = 0')
    .get('material', materialId) as EmbeddingRow | undefined;
  if (!row || row.model !== model) return null;
  return blobToVector(row.vector);
}

/** upsert 单条素材向量（素材级联删除由外键承担；重嵌入即整行覆盖） */
export function upsertMaterialEmbedding(db: DB, materialId: number, model: string, vector: number[]): void {
  const normalized = normalize(vector);
  db.prepare(
    `INSERT INTO doc_embeddings (entity_type, entity_id, chunk_index, vector, model, dim)
     VALUES ('material', ?, 0, ?, ?, ?)
     ON CONFLICT (entity_type, entity_id, chunk_index)
     DO UPDATE SET vector = excluded.vector, model = excluded.model, dim = excluded.dim,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  ).run(materialId, vectorToBlob(normalized), model, normalized.length);
}

/**
 * 素材写路径的同步增量索引：嵌入当前内容并落库。
 * embed 路由未配置或嵌入失败都不抛错（返回 ok:false），素材写路径照常完成。
 * 模型标识以解析路由为准（不用服务响应回显的 model）：保证 stale 判定与落库标识自洽，
 * 服务回显名与请求名不一致时不会出现「永远误判 stale」。
 */
export async function syncMaterialEmbedding(db: DB, llm: LLMProvider, record: MaterialRecord): Promise<EmbeddingSyncResult> {
  const model = embedRouteModel(db);
  if (!model) return { ok: false, error: 'embed 路由未配置' };
  const text = materialEmbedText(record);
  if (text === '') return { ok: true, model };
  try {
    const result = await llm.embed({ texts: [text] });
    const vector = result.vectors[0];
    if (!vector) return { ok: false, error: '嵌入服务返回向量条数不足' };
    upsertMaterialEmbedding(db, record.id, model, vector);
    return { ok: true, model };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export interface ReindexOutcome {
  model: string;
  indexed: number;
  failed: { id: number; title: string; error: string }[];
}

/**
 * 批量重建向量索引：对所有「缺当前 model 向量」的素材（从未索引过 / 内容变了失败过 /
 * 换了嵌入模型）分批重嵌。embed 路由未配置时抛错（API 层映射 409）。
 */
export async function reindexMaterialEmbeddings(db: DB, llm: LLMProvider): Promise<ReindexOutcome> {
  const model = embedRouteModel(db);
  if (!model) throw new Error('embed 路由未配置（应由 API 层先映射 409）');

  const pending = db
    .prepare(
      `SELECT m.id, m.title
       FROM materials m
       LEFT JOIN doc_embeddings e
         ON e.entity_type = 'material' AND e.entity_id = m.id AND e.model = ?
       WHERE e.id IS NULL
       ORDER BY m.id`
    )
    .all(model) as { id: number; title: string }[];

  let indexed = 0;
  const failed: ReindexOutcome['failed'] = [];
  for (let start = 0; start < pending.length; start += EMBED_BATCH_SIZE) {
    const batch = pending.slice(start, start + EMBED_BATCH_SIZE);
    const texts = new Map<number, string>();
    const inputs: string[] = [];
    for (const item of batch) {
      const record = getMaterial(db, item.id);
      if (!record) continue;
      const text = materialEmbedText(record);
      if (text === '') continue;
      texts.set(item.id, text);
      inputs.push(text);
    }
    if (inputs.length === 0) continue;
    try {
      const result = await llm.embed({ texts: inputs });
      let offset = 0;
      for (const [id] of texts) {
        const vector = result.vectors[offset];
        offset += 1;
        if (!vector) {
          failed.push({ id, title: batch.find((item) => item.id === id)?.title ?? '', error: '嵌入服务返回向量条数不足' });
          continue;
        }
        // 落库标识用路由 model（与 stale 判定同口径），不取响应回显
        upsertMaterialEmbedding(db, id, model, vector);
        indexed += 1;
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      for (const item of batch) {
        if (texts.has(item.id)) failed.push({ id: item.id, title: item.title, error });
      }
    }
  }
  return { model, indexed, failed };
}

// ---------- 正文块向量（T19） ----------

export interface ChapterBlockSyncResult extends EmbeddingSyncResult {
  /** 本次写入的块数（路由未配置或失败时为 0） */
  blocks: number;
}

/** 删书时的正文块向量清理（应用层级联：doc_embeddings 已无外键） */
export function deleteChapterBlockEmbeddingsByBook(db: DB, bookId: number): void {
  db.prepare(
    `DELETE FROM doc_embeddings WHERE entity_type = 'chapter_block'
     AND entity_id IN (SELECT id FROM chapters WHERE book_id = ?)`
  ).run(bookId);
}

/** 素材删除时的向量清理（应用层级联，替代 v15 外键；由素材删除路由调用） */
export function deleteMaterialEmbeddings(db: DB, materialId: number): void {
  db.prepare(`DELETE FROM doc_embeddings WHERE entity_type = 'material' AND entity_id = ?`).run(materialId);
}

function hasChapterBlockEmbeddings(db: DB, chapterId: number, model: string): boolean {
  const row = db
    .prepare(`SELECT id FROM doc_embeddings WHERE entity_type = 'chapter_block' AND entity_id = ? AND model = ? LIMIT 1`)
    .get(chapterId, model);
  return row !== undefined;
}

function replaceChapterBlockRows(db: DB, chapterId: number, model: string, vectors: number[][]): void {
  const insert = db.prepare(
    `INSERT INTO doc_embeddings (entity_type, entity_id, chunk_index, vector, model, dim)
     VALUES ('chapter_block', ?, ?, ?, ?, ?)
     ON CONFLICT (entity_type, entity_id, chunk_index)
     DO UPDATE SET vector = excluded.vector, model = excluded.model, dim = excluded.dim,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  );
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM doc_embeddings WHERE entity_type = 'chapter_block' AND entity_id = ?`).run(chapterId);
    vectors.forEach((vector, chunkIndex) => {
      const normalized = normalize(vector);
      insert.run(chapterId, chunkIndex, vectorToBlob(normalized), model, normalized.length);
    });
  });
  run();
}

/**
 * 单章正文块向量回灌（T19）：切块 → 批量嵌入 → 整章替换。
 * commit 旁路与人工编辑路径共用；失败静默语义由返回值表达，调用方 catch 兜底即可。
 */
export async function syncChapterBlockEmbeddings(db: DB, llm: LLMProvider, bookId: number, idx: number): Promise<ChapterBlockSyncResult> {
  const model = embedRouteModel(db);
  if (!model) return { ok: false, error: 'embed 路由未配置', blocks: 0 };
  const chapterId = getChapterId(db, bookId, idx);
  const chapter = chapterId === null ? null : getChapter(db, bookId, idx);
  if (chapterId === null || !chapter) return { ok: false, error: `书 ${bookId} 还没有第 ${idx} 章`, blocks: 0 };

  const blocks = splitChapterBlocks(chapter.content);
  if (blocks.length === 0) {
    replaceChapterBlockRows(db, chapterId, model, []);
    return { ok: true, model, blocks: 0 };
  }
  try {
    const vectors: number[][] = [];
    for (let start = 0; start < blocks.length; start += EMBED_BATCH_SIZE) {
      const batch = blocks.slice(start, start + EMBED_BATCH_SIZE).map((block) => block.text);
      const result = await llm.embed({ texts: batch });
      if (result.vectors.length !== batch.length) return { ok: false, error: '嵌入服务返回向量条数不足', blocks: 0 };
      vectors.push(...result.vectors);
    }
    replaceChapterBlockRows(db, chapterId, model, vectors);
    return { ok: true, model, blocks: blocks.length };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), blocks: 0 };
  }
}

export interface ChapterBlockReindexOutcome {
  model: string;
  /** 重建的章数 */
  indexed: number;
  failed: { idx: number; title: string; error: string }[];
}

/** 书级重建正文索引：对缺当前模型向量的章逐章重灌（换模型 stale / 失败补跑） */
export async function reindexChapterBlockEmbeddings(db: DB, llm: LLMProvider, bookId: number): Promise<ChapterBlockReindexOutcome> {
  const model = embedRouteModel(db);
  if (!model) throw new Error('embed 路由未配置（应由 API 层先映射 409）');

  const chapters = listChapters(db, bookId);
  let indexed = 0;
  const failed: ChapterBlockReindexOutcome['failed'] = [];
  for (const chapter of chapters) {
    if (hasChapterBlockEmbeddings(db, getChapterId(db, bookId, chapter.idx) ?? -1, model)) continue;
    const result = await syncChapterBlockEmbeddings(db, llm, bookId, chapter.idx);
    if (result.ok) {
      indexed += 1;
    } else {
      failed.push({ idx: chapter.idx, title: chapter.title, error: result.error ?? '未知错误' });
    }
  }
  return { model, indexed, failed };
}
