import { describe, expect, it } from 'vitest';
import { embeddingSimilarity, getMaterialEmbedding, materialEmbedText } from '../src/embeddings/store';
import { FAKE_EMBED_DIM, FakeLLM } from '../src/llm/fake';
import { configureRoute, createTestApp, seedMaterial, type TestEnv } from './helpers';

/** 直查素材当前向量行（绕过 model 过滤，看落盘实况） */
function rawEmbeddingRow(db: TestEnv['db'], materialId: number) {
  return db.prepare('SELECT model, dim, vector FROM doc_embeddings WHERE entity_id = ?').get(materialId) as
    | { model: string; dim: number; vector: Buffer }
    | undefined;
}

describe('FakeLLM 确定性伪向量', () => {
  it('同文本恒同向量；非空向量 L2 归一化；共享字面的文本方向相近', async () => {
    const llm = new FakeLLM();
    const [a, b, c, d] = await Promise.all([
      llm.embed({ texts: ['玄铁令是玄天宗信物'] }),
      llm.embed({ texts: ['玄铁令是玄天宗信物'] }),
      llm.embed({ texts: ['玄天宗信物考'] }),
      llm.embed({ texts: ['完全无关的一段文字'] }),
    ]);
    expect(a.vectors[0]).toEqual(b.vectors[0]);
    const vector = a.vectors[0]!;
    expect(vector).toHaveLength(FAKE_EMBED_DIM);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 5);
    // 共享 2-gram 的文本相似度高于无关文本（装填排序断言的基础语义）
    expect(embeddingSimilarity(vector, c.vectors[0]!)).toBeGreaterThan(embeddingSimilarity(vector, d.vectors[0]!));
  });

  it('空文本为零向量；script.embed 可注入指定结果或错误', async () => {
    const llm = new FakeLLM();
    const empty = await llm.embed({ texts: [''] });
    expect(empty.vectors[0]).toEqual(new Array(FAKE_EMBED_DIM).fill(0));

    const scripted = new FakeLLM({ embed: { vectors: [[1, 0, 0]], model: 'bge-m3' } });
    await expect(scripted.embed({ texts: ['任意'] })).resolves.toEqual({ vectors: [[1, 0, 0]], model: 'bge-m3' });

    const failing = new FakeLLM({ embed: new Error('嵌入服务宕机') });
    await expect(failing.embed({ texts: ['任意'] })).rejects.toThrow('嵌入服务宕机');
  });

  it('embeddingSimilarity：归一化向量点积即余弦，维度不一致返回 0', () => {
    expect(embeddingSimilarity([1, 0], [0, 1])).toBe(0);
    expect(embeddingSimilarity([1, 0], [1, 0])).toBe(1);
    expect(embeddingSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(embeddingSimilarity([], [])).toBe(0);
  });

  it('materialEmbedText：标题 + 正文 + payload 字段 + 标签合一', () => {
    const text = materialEmbedText({
      id: 1,
      type: 'setting',
      title: '玄铁令',
      content: '玄天宗信物。',
      payload: { category: '神兵' },
      tags: ['法器'],
      source: { kind: 'manual', book: '', chapter: '' },
      createdAt: '',
      updatedAt: '',
    } as Parameters<typeof materialEmbedText>[0]);
    expect(text).toContain('玄铁令');
    expect(text).toContain('玄天宗信物。');
    expect(text).toContain('神兵');
    expect(text).toContain('法器');
  });
});

describe('T16 素材向量索引：写路径同步', () => {
  it('创建素材自动索引：向量落库、模型取自嵌入结果', async () => {
    const llm = new FakeLLM();
    const { request, db } = createTestApp(llm);
    await configureRoute(request, 'embed');

    const material = await seedMaterial(request, { type: 'setting', title: '玄铁令', content: '玄天宗信物。' });
    expect(llm.embedCalls).toHaveLength(1);

    // 落库模型标识 = 解析路由的 model（configureRoute 种的 'embed-model'），不取服务回显
    const row = rawEmbeddingRow(db, material.id);
    expect(row).toBeDefined();
    expect(row!.model).toBe('embed-model');
    expect(row!.dim).toBe(FAKE_EMBED_DIM);
    expect(getMaterialEmbedding(db, material.id, 'embed-model')).not.toBeNull();
    // 模型不匹配视为缺失（换模型后 stale 的语义）
    expect(getMaterialEmbedding(db, material.id, 'bge-m3')).toBeNull();
  });

  it('embed 失败不阻塞素材入库：素材照常创建，仅无向量行', async () => {
    const llm = new FakeLLM({ embed: new Error('嵌入服务宕机') });
    const { request, db } = createTestApp(llm);
    await configureRoute(request, 'embed');

    const material = await seedMaterial(request, { type: 'trope', title: '觉醒桥段', content: '废柴逆袭。' });
    expect(llm.embedCalls).toHaveLength(1);
    expect(rawEmbeddingRow(db, material.id)).toBeUndefined();
  });

  it('更新素材重嵌：向量行被覆盖，调用数随写路径增长', async () => {
    const llm = new FakeLLM();
    const { request, db } = createTestApp(llm);
    await configureRoute(request, 'embed');

    const material = await seedMaterial(request, { type: 'setting', title: '玄铁令', content: '旧内容。' });
    const before = rawEmbeddingRow(db, material.id)!;
    const res = await request.patch(`/api/materials/${material.id}`, { content: '覆写后的全新内容。' });
    expect(res.status).toBe(200);

    const after = rawEmbeddingRow(db, material.id)!;
    expect(llm.embedCalls).toHaveLength(2);
    expect(after.vector).not.toEqual(before.vector);
    expect(getMaterialEmbedding(db, material.id, 'embed-model')).not.toBeNull();
  });

  it('删除素材：向量行随外键级联消失', async () => {
    const llm = new FakeLLM();
    const { request, db } = createTestApp(llm);
    await configureRoute(request, 'embed');

    const material = await seedMaterial(request, { type: 'style', title: '雪原描写', content: '风雪掠过旷野。' });
    expect(rawEmbeddingRow(db, material.id)).toBeDefined();
    const res = await request.delete(`/api/materials/${material.id}`);
    expect(res.status).toBe(204);
    expect(rawEmbeddingRow(db, material.id)).toBeUndefined();
  });
});

describe('T16 向量索引：批量重建', () => {
  it('未配置 embed 路由 → 409', async () => {
    const { request } = createTestApp();
    const res = await request.post('/api/materials/embeddings/reindex', {});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('embed');
  });

  it('补齐缺失向量；换嵌入模型（重配路由）后旧行 stale，重建后归到新模型', async () => {
    // 阶段一：embed 脚本失败建素材（无向量行）
    const llm = new FakeLLM({ embed: new Error('宕机') });
    const { request, db } = createTestApp(llm);
    await configureRoute(request, 'embed');
    const m1 = await seedMaterial(request, { type: 'setting', title: '玄铁令', content: '信物。' });
    const m2 = await seedMaterial(request, { type: 'trope', title: '打脸桥段', content: '当众打脸。' });
    expect(rawEmbeddingRow(db, m1.id)).toBeUndefined();

    // 阶段二：恢复嵌入，重索引补齐（落库标识 = 路由 model 'embed-model'）
    llm.script.embed = undefined;
    const res = await request.post('/api/materials/embeddings/reindex', {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: 'embed-model', indexed: 2, failed: [] });
    expect(getMaterialEmbedding(db, m1.id, 'embed-model')).not.toBeNull();
    expect(getMaterialEmbedding(db, m2.id, 'embed-model')).not.toBeNull();

    // 阶段三：路由换到另一嵌入模型（不经素材编辑）→ 旧行对当前模型是 stale → 重建归到新模型
    const retarget = await request.put('/api/settings/routes/embed', { model: 'bge-m3' });
    expect(retarget.status).toBe(200);
    const again = await request.post('/api/materials/embeddings/reindex', {});
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ model: 'bge-m3', indexed: 2, failed: [] });
    expect(getMaterialEmbedding(db, m1.id, 'bge-m3')).not.toBeNull();
    expect(getMaterialEmbedding(db, m1.id, 'embed-model')).toBeNull();
  });

  it('批量嵌入失败逐条记失败清单，不中断其余', async () => {
    const llm = new FakeLLM({ embed: new Error('批量宕机') });
    const { request, db } = createTestApp(llm);
    await configureRoute(request, 'embed');
    const m1 = await seedMaterial(request, { type: 'setting', title: '甲', content: '内容甲。' });
    await seedMaterial(request, { type: 'setting', title: '乙', content: '内容乙。' });

    const res = await request.post('/api/materials/embeddings/reindex', {});
    expect(res.status).toBe(200);
    expect(res.body.indexed).toBe(0);
    expect(res.body.failed).toHaveLength(2);
    expect(res.body.failed.map((item: { id: number }) => item.id).sort()).toEqual([m1.id, m1.id + 1].sort());
    expect(res.body.failed[0]!.error).toContain('批量宕机');
    expect(rawEmbeddingRow(db, m1.id)).toBeUndefined();
  });
});

describe('T16 embed 路由', () => {
  it('embed 任务可指派路由，连通测试走 embed 调用而非 chat', async () => {
    const llm = new FakeLLM();
    const { request } = createTestApp(llm);
    await configureRoute(request, 'embed');

    const routes = await request.get('/api/settings/routes');
    expect(routes.status).toBe(200);
    const embedRow = (routes.body as { task: string }[]).find((row) => row.task === 'embed');
    expect(embedRow).toBeDefined();

    const before = llm.embedCalls.length;
    const test = await request.post('/api/settings/routes/embed/test', {});
    expect(test.status).toBe(200);
    expect(test.body.ok).toBe(true);
    expect(test.body.model).toBe('embed-model');
    // 探测调用的是 embed 接缝（未发 chat 请求）
    expect(llm.embedCalls.length).toBe(before + 1);
    expect(llm.embedCalls.at(-1)!.texts).toEqual(['ping']);
  });
});
