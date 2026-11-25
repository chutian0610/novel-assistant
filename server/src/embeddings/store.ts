import type { DB } from '../db/open';
import { resolveRoute } from '../llm/resolver';
import type { LLMProvider } from '../llm/types';
import { getMaterial, type MaterialRecord } from '../materials/store';

/**
 * 向量索引（T16，ADR-0002：embedding 只是装填排序的增强，不是一致性的数据源）。
 *
 * 关键决策：
 * - 索引对象是素材的**全局内容**（与 FTS 同口径：检索走全局索引，注入用书内覆写后的生效内容）。
 * - 向量 L2 归一化后落 BLOB（Float32Array），余弦退化为点积；维度从嵌入服务响应读取
 *   （ollama 本地模型 768/1024 各不相同，不手动配置）。
 * - model 进行：不同嵌入模型的向量永不混比；换模型后旧行成为 stale，由 reindex 补齐。
 * - embedding 失败不阻塞素材写路径：索引失败只返回错误信息，素材照常入库；
 *   查询侧（T17 混合排序）只对有当前 model 向量的素材生效，自动跳过缺失项。
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
