export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function readResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  if (!res.ok) throw await toApiError(res);
  const data: unknown = await res.json().catch(() => null);
  return data as T;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readResponse<T>(res);
}

/** 非 2xx 响应 → ApiError（错误体按 JSON {error} 解析，读不出来退回状态码文案） */
async function toApiError(res: Response): Promise<ApiError> {
  const data: unknown = await res.json().catch(() => null);
  const message = (data as { error?: string } | null)?.error ?? `请求失败（HTTP ${res.status}）`;
  return new ApiError(message, res.status);
}

/** 读取纯文本响应（导出下载）；错误仍按 JSON {error} 解析 */
async function callText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw await toApiError(res);
  return res.text();
}

/** 上传原始请求体（拆书：txt/epub 文件直传，无 multipart） */
async function callRaw<T>(url: string, body: string | Blob, contentType: string): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body });
  return readResponse<T>(res);
}

export const api = {
  get: <T>(url: string) => call<T>('GET', url),
  post: <T>(url: string, body: unknown) => call<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => call<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => call<T>('PUT', url, body),
  delete: <T>(url: string) => call<T>('DELETE', url),
  postRaw: <T>(url: string, body: string | Blob, contentType: string) => callRaw<T>(url, body, contentType),
  getText: (url: string) => callText(url),
};

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
