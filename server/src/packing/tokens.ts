/**
 * Token 估算（确定性纯函数）：用 Intl.Segmenter 中文分词的词元数近似 token 数
 * （spec：中文分词用 Node 原生 Intl.Segmenter，不引入 jieba）。
 * V1 只用于预算装填的占比展示与截断，不追求与具体供应商 tokenizer 一致；
 * 日后接入真实 tokenizer 只需替换本函数，装填逻辑不变。
 */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** 估算文本的 token 数：词元计数（标点不计；空文本为 0） */
export function estimateTokens(text: string): number {
  let count = 0;
  for (const part of segmenter.segment(text)) {
    if (part.isWordLike) count += 1;
  }
  return count;
}
