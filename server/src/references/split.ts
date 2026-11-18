import { strFromU8, unzipSync } from 'fflate';

/** 章节标题行：行首为「第 X 章/节/卷/回/集」（汉字或数字序号）或常见特殊章名，行长受限避免误伤正文 */
const CHAPTER_TITLE_RE =
  /^\s{0,4}(?:第\s*[0-9〇零一二三四五六七八九十百千万两]+\s*[章节卷回集][^\n]{0,40}|序章[^\n]{0,40}|楔子[^\n]{0,40}|引子[^\n]{0,40}|前言[^\n]{0,40}|后记[^\n]{0,40}|尾声[^\n]{0,40}|终章[^\n]{0,40}|Chapter\s+\d+[^\n]{0,40})\s*$/i;

export interface ParsedChapter {
  title: string;
  content: string;
}

/**
 * 参考书文本解码：优先 UTF-8；出现替换符（U+FFFD）时尝试 GB18030（中文网文 txt 常见编码），
 * 取替换符更少的解码结果。
 */
export function decodeReferenceText(bytes: Buffer): string {
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gb18030 = new TextDecoder('gb18030').decode(bytes);
    const replacements = (text: string) => (text.match(/\uFFFD/g) ?? []).length;
    return replacements(gb18030) < replacements(utf8) ? gb18030 : utf8;
  } catch {
    return utf8;
  }
}

/** 纯文本分章：标题行开启新章，首个标记前的内容归入「开篇」，无任何标记时整本归入「全文」 */
export function splitTxtChapters(raw: string): ParsedChapter[] {
  const lines = raw.split(/\r?\n/);
  const chapters: ParsedChapter[] = [];
  let current: ParsedChapter | null = null;
  const flush = () => {
    if (!current) return;
    const content = current.content.trim();
    if (content.length > 0 || chapters.length === 0) chapters.push({ title: current.title, content });
    current = null;
  };

  for (const line of lines) {
    if (CHAPTER_TITLE_RE.test(line)) {
      flush();
      current = { title: line.trim(), content: '' };
    } else {
      if (!current) current = { title: '', content: '' };
      current.content += `${line}\n`;
    }
  }
  flush();

  if (chapters.length === 0) return [];
  // 无任何章节标记：整本归入单章「全文」
  if (chapters.length === 1 && chapters[0]!.title === '') {
    return [{ title: '全文', content: chapters[0]!.content }];
  }
  // 首个标记前的散落内容（无标题）归入「开篇」
  const head = chapters[0]!;
  if (head.title === '') {
    return [{ title: '开篇', content: head.content }, ...chapters.slice(1)];
  }
  return chapters;
}

/** epub → 按 spine 顺序拼接的纯文本（含元数据书名，缺失时为 undefined） */
export function parseEpub(buffer: Buffer): { title?: string; text: string } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new Error('无法解析 epub：不是合法的 zip 文件');
  }

  const containerXml = readText(entries, 'META-INF/container.xml');
  const opfPath = /full-path="([^"]+)"/.exec(containerXml)?.[1];
  if (!opfPath || !(opfPath in entries)) throw new Error('无法解析 epub：container.xml 缺少 rootfile');

  const opfXml = readText(entries, opfPath);
  const title = /<dc:title[^>]*>([^<]+)<\/dc:title>/.exec(opfXml)?.[1]?.trim();
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  // manifest id → href（只取 HTML 文档，属性顺序无关），按 spine 顺序拼接
  const hrefs = new Map<string, string>();
  for (const [tag] of opfXml.matchAll(/<item\s+([^>]*?)\/?>/g)) {
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    const mediaType = /\bmedia-type="([^"]+)"/.exec(tag)?.[1];
    if (id && href && mediaType && /xhtml|html/.test(mediaType)) hrefs.set(id, href);
  }
  const spineIds = [...opfXml.matchAll(/<itemref\s+[^>]*idref="([^"]+)"/g)].map((m) => m[1]!);
  const parts: string[] = [];
  for (const id of spineIds) {
    const href = hrefs.get(id);
    if (!href) continue;
    const entryPath = decodeURIComponent(href.startsWith('/') ? href.slice(1) : baseDir + href);
    if (entryPath in entries) parts.push(htmlToText(readText(entries, entryPath)));
  }
  if (parts.length === 0) throw new Error('无法解析 epub：spine 中没有可读的 HTML 文档');
  return { title, text: parts.join('\n\n') };
}

function readText(entries: Record<string, Uint8Array>, path: string): string {
  const data = entries[path];
  if (!data) throw new Error(`无法解析 epub：缺少 ${path}`);
  return strFromU8(data);
}

/** XHTML/HTML → 纯文本：去掉 head/script/style，块级元素换行，剥离标签并解码常见实体 */
export function htmlToText(html: string): string {
  const withoutInvisible = html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const withBreaks = withoutInvisible.replace(/<\/(p|h[1-6]|div|li|tr|blockquote|section)>|<br\s*\/?>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  return decodeEntities(stripped)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (raw, name: string) => named[name.toLowerCase()] ?? raw);
}
