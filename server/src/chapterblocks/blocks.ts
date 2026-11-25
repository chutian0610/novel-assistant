/**
 * 正文段落切块（T19，确定性纯函数）：呼应检索与跨章自相似的最小语义单元。
 * 按空行切段、过短段并入相邻段（目标块长 BLOCK_TARGET_MIN~BLOCK_TARGET_MAX 字），
 * 超长单段独立成块（不在段内劈开——段落是作者的自然语义边界）。
 * 幂等：同正文恒得同块序列；chunk_index 即序列下标（doc_embeddings.chunk_index 的取值域）。
 */

export const BLOCK_TARGET_MIN = 200;
export const BLOCK_TARGET_MAX = 400;

export interface ChapterBlock {
  index: number;
  text: string;
}

export function splitChapterBlocks(content: string): ChapterBlock[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter((para) => para !== '');
  const blocks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const para of paragraphs) {
    // 已达下限且再并入将超上限 → 先落块再开新块；其余情况一律并入（过短段由此与相邻段合流）
    if (current.length > 0 && currentLength >= BLOCK_TARGET_MIN && currentLength + para.length > BLOCK_TARGET_MAX) {
      blocks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(para);
    currentLength += (current.length > 1 ? 1 : 0) + para.length; // 段间以换行接续，计入 1 字
  }
  if (current.length > 0) blocks.push(current);
  return blocks.map((block, index) => ({ index, text: block.join('\n') }));
}
