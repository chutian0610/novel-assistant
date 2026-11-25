import type { ChatRequest, ChatResult, EmbedRequest, EmbedResult, LLMProvider, TaskType } from './types';

export interface FakeLLMCall {
  task: TaskType;
  req: ChatRequest;
}

export interface FakeLLMScript {
  /** 按任务脚本化响应（返回值或抛出的错误）；未脚本化的任务返回默认结果 */
  respond?: Partial<Record<TaskType, ChatResult | Error>>;
  /** 按调用顺序逐个弹出（多轮脚本化，如逐章抽取）；弹尽后回退 respond，再回退默认值 */
  respondSequence?: Partial<Record<TaskType, (ChatResult | Error)[]>>;
  /** 向量化响应脚本；未脚本化时返回确定性伪向量 */
  embed?: EmbedResult | Error;
}

/** 伪向量维度：小到断言快，大到足够容纳字符 2-gram 的区分度 */
export const FAKE_EMBED_DIM = 64;

/**
 * 测试范式的注入假实现（spec：唯一 mock 点 = LLMProvider 接缝）。
 * 记录每次调用供测试断言，其余一切（HTTP、SQLite）都用真实实现。
 * script 公开可变：测试可在流程中途补充/改写脚本（如断点续跑的分段脚本）。
 */
export class FakeLLM implements LLMProvider {
  readonly calls: FakeLLMCall[] = [];
  readonly embedCalls: EmbedRequest[] = [];

  constructor(public readonly script: FakeLLMScript = {}) {}

  async complete(task: TaskType, req: ChatRequest): Promise<ChatResult> {
    this.calls.push({ task, req });
    const sequence = this.script.respondSequence?.[task];
    if (sequence && sequence.length > 0) {
      const next = sequence.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }
    const scripted = this.script.respond?.[task];
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;
    return { content: `fake:${task}`, model: 'fake-model' };
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    this.embedCalls.push(req);
    const scripted = this.script.embed;
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;
    // 确定性伪向量：字符 2-gram 计数 + 归一化（同文本恒同向量，共享字面的文本方向相近，
    // 供装填排序/索引同步类测试做可预测断言）
    return { vectors: req.texts.map(fakeVector), model: 'fake-embed' };
  }
}

/** djb2 字符串哈希（确定性，跨进程稳定——不用 Math.random/内置 hash） */
function hashGram(gram: string): number {
  let hash = 5381;
  for (let i = 0; i < gram.length; i++) {
    hash = ((hash << 5) + hash + gram.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** 字符 2-gram 计数向量，L2 归一化；空文本为零向量（余弦恒 0，不参与相似命中） */
function fakeVector(text: string): number[] {
  const counts = new Array<number>(FAKE_EMBED_DIM).fill(0);
  for (let i = 0; i < text.length - 1; i++) {
    const index = hashGram(text.slice(i, i + 2)) % FAKE_EMBED_DIM;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(counts.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return counts;
  return counts.map((value) => value / norm);
}
