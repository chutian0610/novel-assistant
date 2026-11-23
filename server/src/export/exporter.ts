import type { DB } from '../db/open';
import { getBook, type BookRecord } from '../books/store';
import { getVolume, getOutlineTree } from '../outlines/store';
import { getChapter } from '../pipeline/store';

/**
 * 全书/分卷导出（T14，spec 用户故事 38）：txt 与 markdown 两种格式。
 *
 * 结构（freeze 于测试 export.test.ts）：
 * - txt 全书：`《书名》` 空行起头，逐章 `章标题 / 空行 / 正文 / 空行`；
 * - txt 分卷：头行 `《书名》·卷标题`，其后同逐章格式；
 * - markdown 全书：`# 书名`，逐章 `## 章标题`；
 * - markdown 分卷：`# 书名·卷标题`，逐章 `## 章标题`。
 *
 * 只导出已落稿章节（pipeline commit 产物，按章号升序）；卷选择不改变章号——章号即大纲树
 * 顺序，跨卷连续。无任何落稿章节时抛 ExportEmptyError（API 层映射 409）。
 */

export const EXPORT_FORMATS = ['txt', 'markdown'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  txt: 'text/plain; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
};

export class ExportEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportEmptyError';
  }
}

export interface ExportResult {
  contentType: string;
  body: string;
}

/** 导出全书或指定卷（volumeId 缺省为全书）；书存在性由 API 层 requireBook 前置 */
export function exportBook(db: DB, bookId: number, format: ExportFormat, volumeId?: number): ExportResult {
  const book: BookRecord | null = getBook(db, bookId);
  if (!book) throw new Error(`书 ${bookId} 不存在（应先由 API 层 404 拦截）`);

  let volumeSuffix = '';
  if (volumeId !== undefined) {
    const volume = getVolume(db, bookId, volumeId);
    if (!volume) throw new VolumeNotFoundError(volumeId);
    volumeSuffix = `·${volume.title}`;
  }

  // 章号 → 卷归属：大纲树扁平序（与 packing 同一映射规则），按卷过滤
  const tree = getOutlineTree(db, bookId);
  const chapters: { title: string; content: string }[] = [];
  let ordinal = 0;
  for (const volume of tree.volumes) {
    const count = volume.chapters.length;
    if (volumeId === undefined || volume.id === volumeId) {
      for (let offset = 1; offset <= count; offset++) {
        const chapter = getChapter(db, bookId, ordinal + offset);
        if (chapter) chapters.push({ title: chapter.title, content: chapter.content });
      }
    }
    ordinal += count;
  }
  if (chapters.length === 0) {
    throw new ExportEmptyError(`书「${book.title}」还没有已落稿章节，无法导出`);
  }

  // txt 头行用书名号包书名（网文 txt 惯例，卷名缀后），markdown 保持常规标题层级
  const header = format === 'txt' ? `《${book.title}》${volumeSuffix}` : `# ${book.title}${volumeSuffix}`;
  const chapterPrefix = format === 'txt' ? '' : '## ';
  const body =
    `${header}\n\n` +
    chapters.map((chapter) => `${chapterPrefix}${chapter.title}\n\n${chapter.content}\n\n`).join('');
  return { contentType: EXPORT_CONTENT_TYPES[format], body };
}

export class VolumeNotFoundError extends Error {
  constructor(volumeId: number) {
    super(`卷纲 ${volumeId} 不存在`);
    this.name = 'VolumeNotFoundError';
  }
}
