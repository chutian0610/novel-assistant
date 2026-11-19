import { segmentParts, wordTokens } from '../lang/segment';

/**
 * 中文分词的领域适配（spec：Node 原生 Intl.Segmenter，不引入 jieba）。
 * FTS5 的 unicode61 分词器按空白切词，因此入库前把文本预分词为空格连接的形式，
 * 查询串同样分词后逐词加引号（AND 语义），保证中文子词可命中正文。
 */

/** 拼接素材各字段为索引文本：标题、正文、结构化字段、标签、溯源 */
export function buildSearchText(parts: readonly (string | undefined | null)[]): string {
  return wordTokens(parts.filter((part): part is string => Boolean(part && part.trim())).join(' ')).join(' ');
}
/** 把用户查询转为 FTS5 MATCH 语法（AND）；无可分词内容（如纯标点）时返回 null，调用方应忽略搜索条件 */
export function buildMatchQuery(input: string): string | null {
  const tokens = wordTokens(input);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(' ');
}

/**
 * 装填检索（T9）的召回查询，OR 连接。注入视图要「宁可多召回，交给 BM25 排序与预算截断」，
 * 与 buildMatchQuery 的 AND 精确搜索语义不同。
 *
 * 词元分三档处理：多字词直接作 OR 项；连续单字串（词典外专名，如「玄铁令」被切成 玄/铁/令）
 * 合成 FTS5 短语查询，按索引中的相邻字序列命中；孤立单字（的/大/在等）丢弃降噪。
 * 标点与空白打断单字串（「第1章 玄铁令」切成「第 1 章」与「玄 铁 令」两个短语，不跨界粘连）。
 * 全部为空时返回 null，调用方应视为空结果。
 */
export function buildRecallQuery(input: string): string | null {
  const terms: string[] = [];
  let charRun: string[] = [];
  const flushRun = () => {
    if (charRun.length >= 2) terms.push(charRun.map((ch) => `"${ch}"`).join(' '));
    charRun = [];
  };
  for (const part of segmentParts(input)) {
    if (!part.isWordLike) {
      flushRun(); // 标点/空白打断字序列
      continue;
    }
    if (part.segment.length >= 2) {
      flushRun();
      terms.push(`"${part.segment}"`);
    } else {
      charRun.push(part.segment);
    }
  }
  flushRun();
  if (terms.length === 0) return null;
  return [...new Set(terms)].join(' OR ');
}
