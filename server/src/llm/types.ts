/**
 * 任务类型：管线各阶段按任务路由到不同模型配置（spec 用户故事 2）。
 * 注意：web/src/types.ts 有一份镜像副本（前端无构建期共享包），增删任务时须两处同步，
 * 并同步更新 server/src/db/schema.ts 的 CHECK 约束与种子行。
 */
export const TASK_TYPES = ['outline', 'draft', 'extract', 'verify', 'embed', 'analyze'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  model: string;
}

/** 向量化请求：一批文本各产出一个向量（OpenAI 兼容 /embeddings 的 input 数组） */
export interface EmbedRequest {
  texts: string[];
}

export interface EmbedResult {
  /** 与 texts 一一对应；维度由服务端响应决定（ollama 本地模型各不相同，不手动配置） */
  vectors: number[][];
  model: string;
}

/** 解析后的生效配置：供应商三件套 + 路由覆写后的模型 */
export interface ResolvedRoute {
  providerId: number;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 代码中唯一的 LLM 出口（ADR-0003 / spec 测试范式）：
 * 生产注入 createRoutedProvider，测试注入 FakeLLM；除此之外任何模块不得直连 LLM 服务。
 * complete 走 chat/completions（按 task 路由）；embed 走 /embeddings（固定 embed 路由）。
 */
export interface LLMProvider {
  complete(task: TaskType, req: ChatRequest): Promise<ChatResult>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
}

/** 连通性测试用的最小请求，控制探测成本 */
export const PROBE_REQUEST: ChatRequest = {
  messages: [{ role: 'user', content: 'ping' }],
  maxTokens: 8,
};

/** embed 路由的连通性探测文本（单条短文本，控制探测成本） */
export const EMBED_PROBE_TEXT = 'ping';

export class LLMError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LLMError';
  }
}
