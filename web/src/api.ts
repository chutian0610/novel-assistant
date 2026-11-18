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
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `请求失败（HTTP ${res.status}）`;
    throw new ApiError(message, res.status);
  }
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
};

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
