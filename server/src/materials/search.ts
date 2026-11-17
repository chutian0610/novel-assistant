/**
 * 中文分词（spec：Node 原生 Intl.Segmenter，不引入 jieba）。
 * FTS5 的 unicode61 分词器按空白切词，因此入库前把文本预分词为空格连接的形式，
 * 查询串同样分词后逐词加引号（AND 语义），保证中文子词可命中正文。
 */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

function wordTokens(input: string): string[] {
  const tokens: string[] = [];
  for (const part of segmenter.segment(input)) {
    if (part.isWordLike) tokens.push(part.segment);
  }
  return tokens;
}

/** 把任意文本转为空格连接的分词串（用于 FTS 索引列） */
export function segmentText(input: string): string {
  return wordTokens(input).join(' ');
}

/** 把用户查询转为 FTS5 MATCH 语法；无可分词内容（如纯标点）时返回 null，调用方应忽略搜索条件 */
export function buildMatchQuery(input: string): string | null {
  const tokens = wordTokens(input);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(' ');
}

/** 拼接素材各字段为索引文本：标题、正文、结构化字段、标签、溯源 */
export function buildSearchText(parts: readonly (string | undefined | null)[]): string {
  return segmentText(parts.filter((part): part is string => Boolean(part && part.trim())).join(' '));
}
