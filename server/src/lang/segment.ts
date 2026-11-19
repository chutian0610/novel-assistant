/**
 * 中文分词（spec：Node 原生 Intl.Segmenter，不引入 jieba）。
 * 素材检索与检测器共用的语言工具层。
 */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** 切出词元列表（仅 wordLike；标点/空白不计） */
export function wordTokens(input: string): string[] {
  const tokens: string[] = [];
  for (const part of segmenter.segment(input)) {
    if (part.isWordLike) tokens.push(part.segment);
  }
  return tokens;
}

export interface SegmentPart {
  segment: string;
  isWordLike: boolean;
}

/** 原始分词段（含标点/空白，isWordLike 标记）；需要边界信息（如短语召回的断句）时使用 */
export function segmentParts(input: string): SegmentPart[] {
  return [...segmenter.segment(input)].map((part) => ({ segment: part.segment, isWordLike: part.isWordLike === true }));
}
