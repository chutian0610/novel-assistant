/**
 * LLM 响应的宽容 JSON 剥壳：容忍代码围栏与前后杂讯，取首个 { 到最后一个 } 的切片解析。
 * 服务端各响应解析（大纲展开/拆书抽取/语义核查/事实回灌）共用同一容错口径。
 * 返回 null 表示整体不可解析，由调用方抛各自的 XxxParseError（错误文案随调用方语义）。
 */
export function parseLooseJson(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
