import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// spec 验收纪律：「代码中除 LLMProvider 外无任何直连 LLM 的调用」
// 用静态扫描固化：整个服务端只有 llm/openai.ts 允许出现 HTTP 客户端调用。

const srcRoot = fileURLToPath(new URL('../src', import.meta.url));

const FORBIDDEN_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: '全局 HTTP 调用', regex: /\bfetch\s*\(/ },
  { name: 'openai SDK', regex: /from\s+['"]openai/ },
  { name: 'axios', regex: /\baxios\b/ },
  { name: 'undici', regex: /\bundici\b/ },
];

/** 允许直连 LLM 的唯一文件：适配层的网络出口 */
const ALLOWED_FILES = new Set([path.join('llm', 'openai.ts')]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

it('除 LLM 适配层外，服务端不得出现任何直连 LLM 的调用', () => {
  const files = walk(srcRoot).filter((file) => file.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(0);

  const violations: string[] = [];
  for (const file of files) {
    const rel = path.relative(srcRoot, file);
    if (ALLOWED_FILES.has(rel)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const { name, regex } of FORBIDDEN_PATTERNS) {
      if (regex.test(content)) violations.push(`${rel} 出现${name}（${regex}）`);
    }
  }
  expect(violations).toEqual([]);
});

it('唯一出口 llm/openai.ts 确实存在网络调用', () => {
  const content = fs.readFileSync(path.join(srcRoot, 'llm', 'openai.ts'), 'utf8');
  expect(content).toMatch(/\bfetch\s*\(/);
});
