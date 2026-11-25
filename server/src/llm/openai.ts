import { LLMError, type ChatRequest, type ChatResult, type EmbedRequest, type EmbedResult, type ResolvedRoute } from './types';

const REQUEST_TIMEOUT_MS = 30_000;
const ERROR_BODY_LIMIT = 300;

/**
 * 对 OpenAI 兼容服务发起一次 chat/completions 调用。
 * 这是整个服务端唯一的 LLM 网络出口，只允许被 LLMProvider 的实现调用（见架构纪律测试）。
 */
export async function chatCompletion(route: ResolvedRoute, req: ChatRequest): Promise<ChatResult> {
  const url = `${route.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let res: Response;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // 空 API Key（如本地免鉴权服务）时省略 authorization 头，避免空 Bearer 触发部分服务的 401
  if (route.apiKey !== '') {
    headers.authorization = `Bearer ${route.apiKey}`;
  }
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: route.model,
        messages: req.messages,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new LLMError(`无法连接 LLM 服务（${url}）：${describeCause(cause)}`, { cause });
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT);
    throw new LLMError(`LLM 服务返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }

  const payload: unknown = await res.json().catch(() => {
    throw new LLMError('LLM 服务返回了无法解析的 JSON 响应');
  });
  const content = pickContent(payload);
  if (content === null) {
    throw new LLMError('LLM 响应缺少 choices[0].message.content');
  }
  return { content, model: pickModel(payload) ?? route.model };
}

function pickContent(payload: unknown): string | null {
  const choices = (payload as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return null;
  const first: unknown = choices[0];
  const message = (first as { message?: unknown } | null)?.message;
  const content = (message as { content?: unknown } | null)?.content;
  return typeof content === 'string' ? content : null;
}

/**
 * 对 OpenAI 兼容服务发起一次 /embeddings 调用（唯一 LLM 网络出口的向量分支）。
 * 维度从响应读取（ollama 本地嵌入模型 768/1024 各不相同，不手动配置）；
 * 服务端返回条数必须与输入条数一致，缺失即报错。
 */
export async function embedCompletion(route: ResolvedRoute, req: EmbedRequest): Promise<EmbedResult> {
  if (req.texts.length === 0) return { vectors: [], model: route.model };
  const url = `${route.baseUrl.replace(/\/+$/, '')}/embeddings`;
  let res: Response;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // 空 API Key（如本地免鉴权服务）时省略 authorization 头，避免空 Bearer 触发部分服务的 401
  if (route.apiKey !== '') {
    headers.authorization = `Bearer ${route.apiKey}`;
  }
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: route.model, input: req.texts }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new LLMError(`无法连接 LLM 服务（${url}）：${describeCause(cause)}`, { cause });
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT);
    throw new LLMError(`LLM 服务返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }

  const payload: unknown = await res.json().catch(() => {
    throw new LLMError('LLM 服务返回了无法解析的 JSON 响应');
  });
  const vectors = pickEmbeddings(payload);
  if (!vectors) {
    throw new LLMError('LLM 响应缺少 data[].embedding 数组');
  }
  if (vectors.length !== req.texts.length) {
    throw new LLMError(`嵌入条数不匹配：请求 ${req.texts.length} 条，响应 ${vectors.length} 条`);
  }
  return { vectors, model: pickModel(payload) ?? route.model };
}

/** data[].embedding → number[][]；任一条目缺数或非数组返回 null（调用方统一报错） */
function pickEmbeddings(payload: unknown): number[][] | null {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const vectors: number[][] = [];
  for (const item of data) {
    const embedding = (item as { embedding?: unknown } | null)?.embedding;
    if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== 'number')) return null;
    vectors.push(embedding);
  }
  return vectors;
}

function pickModel(payload: unknown): string | null {
  const model = (payload as { model?: unknown } | null)?.model;
  return typeof model === 'string' && model.length > 0 ? model : null;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
