/** 带 HTTP 状态码的业务错误，由全局错误中间件转为 JSON 响应 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
