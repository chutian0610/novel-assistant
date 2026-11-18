import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import request from 'supertest';
import { afterEach } from 'vitest';
import { createApp } from '../src/app';
import { openDatabase, type DB } from '../src/db/open';
import { FakeLLM } from '../src/llm/fake';
import type { LLMProvider } from '../src/llm/types';

const pending: { db: DB; dir: string }[] = [];

afterEach(() => {
  for (const { db, dir } of pending.splice(0)) {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export interface TestEnv {
  db: DB;
  llm: FakeLLM;
  request: {
    get(url: string): request.Test;
    post(url: string, body?: unknown): request.Test;
    patch(url: string, body?: unknown): request.Test;
    put(url: string, body?: unknown): request.Test;
    delete(url: string): request.Test;
    /** 发送原始请求体（非 JSON），用于上传接口 */
    postRaw(url: string, body: string | Buffer, contentType: string): request.Test;
  };
}

/**
 * 测试范式（spec）：从 HTTP API 打进（supertest）+ 真实 SQLite 临时库，
 * LLM 接缝注入 FakeLLM —— 除此之外不 mock 任何东西。
 */
export function createTestApp(llm: LLMProvider = new FakeLLM()): TestEnv {
  if (!(llm instanceof FakeLLM)) throw new Error('测试必须注入 FakeLLM');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-assistant-test-'));
  const db = openDatabase(path.join(dir, 'test.sqlite'));
  const app = createApp({ db, llm });
  const server = http.createServer(getRequestListener(app.fetch));
  pending.push({ db, dir });

  const agent = request(server);
  const withBody = (method: 'post' | 'patch' | 'put') => (url: string, body?: unknown) =>
    body === undefined ? agent[method](url) : agent[method](url).send(body);

  return {
    db,
    llm,
    request: {
      get: (url) => agent.get(url),
      post: withBody('post'),
      patch: withBody('patch'),
      put: withBody('put'),
      delete: (url) => agent.delete(url),
      postRaw: (url, body, contentType) => agent.post(url).set('content-type', contentType).send(body),
    },
  };
}

export interface TestProvider {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 通过 API 预置一个供应商 */
export async function seedProvider(
  request: TestEnv['request'],
  overrides: Partial<Pick<TestProvider, 'name' | 'baseUrl' | 'apiKey' | 'model' | 'enabled'>> = {}
): Promise<TestProvider> {
  const res = await request.post('/api/settings/providers', {
    name: '测试供应商',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`预置供应商失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

import type { MaterialRecord, MaterialType } from '../src/materials/store';

/** 素材 JSON 形状与 server 的 MaterialRecord 同构，直接复用其类型 */
export type TestMaterial = MaterialRecord;

const MATERIAL_DEFAULTS: Record<MaterialType, { title: string; content: string; payload: Record<string, string> }> = {
  setting: {
    title: '玄天宗',
    content: '北境修真世界的头号宗门，掌门陆沉舟。',
    payload: { category: '势力' },
  },
  trope: {
    title: '开局即冲突',
    content: '主角开场便被卷入灭门之祸，无铺垫直接进入冲突。',
    payload: { structure: '危机前置，倒计时压迫' },
  },
  style: {
    title: '雪原行军',
    content: '风雪掠过旷野，他勒住缰绳，呼吸在寒气里凝成白霜。',
    payload: { rhythm: '短句为主，句长波动大' },
  },
  skeleton: {
    title: '废柴流书骨骼',
    content: '前三章连续小高潮，随后进入第一卷宗门线。',
    payload: {
      pacingCurve: '开局黄金三章，随后节奏放缓',
      volumeStructure: '第一卷宗门试炼，第二卷外出游历',
      archetypes: '隐忍型主角，严厉型师尊',
    },
  },
};

/** 通过 API 预置一条素材 */
export async function seedMaterial(
  request: TestEnv['request'],
  input: {
    type: MaterialType;
    title?: string;
    content?: string;
    payload?: Record<string, string>;
    tags?: string[];
    source?: { kind?: 'manual' | 'reference'; book?: string; chapter?: string };
  }
): Promise<TestMaterial> {
  const defaults = MATERIAL_DEFAULTS[input.type];
  const res = await request.post('/api/materials', {
    type: input.type,
    title: input.title ?? defaults.title,
    content: input.content ?? defaults.content,
    payload: input.payload ?? defaults.payload,
    tags: input.tags ?? ['测试'],
    source:
      input.source ??
      (input.type === 'setting'
        ? { kind: 'reference', book: '参考书甲', chapter: '第3章' }
        : { kind: 'manual' }),
  });
  if (res.status !== 201) throw new Error(`预置素材失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** 书 JSON 形状与 server 的 BookRecord 同构，直接复用其类型 */
export type TestBook = import('../src/books/store').BookRecord;

/** 通过 API 预置一本书（书契约元数据：题材/基调/承诺） */
export async function seedBook(
  request: TestEnv['request'],
  overrides: Partial<Pick<TestBook, 'title' | 'genre' | 'tone' | 'promise'>> = {}
): Promise<TestBook> {
  const res = await request.post('/api/books', {
    title: '北境玄天录',
    genre: '东方玄幻',
    tone: '热血爽文',
    promise: '主角稳步升级，无虐主，伏笔必回收',
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`预置书失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** 书内素材条目 JSON 形状与 server 的 BookMaterialRecord 同构 */
export type TestBookMaterialItem = import('../src/books/store').BookMaterialRecord;

/** 通过 API 把素材引用进书 */
export async function seedBookMaterial(
  request: TestEnv['request'],
  bookId: number,
  materialId: number
): Promise<TestBookMaterialItem> {
  const res = await request.post(`/api/books/${bookId}/materials`, { materialId });
  if (res.status !== 201) throw new Error(`预置书内引用失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

// ---- 拆书提取（T4）----

/** 参考书 JSON 形状与 server 的 ReferenceDetail 同构 */
export type TestReference = import('../src/references/store').ReferenceDetail;

export interface TestChapterInput {
  title: string;
  content: string;
}

/** 通过 API 上传一本 txt 参考书（章标题行 + 正文的纯文本拼接） */
export async function seedReference(
  request: TestEnv['request'],
  chapters: TestChapterInput[],
  title = '参考书·拆书测试'
): Promise<TestReference> {
  const text = chapters.map((c) => `${c.title}\n${c.content}`).join('\n\n');
  const res = await request.postRaw(
    `/api/references?format=txt&title=${encodeURIComponent(title)}`,
    text,
    'text/plain; charset=utf-8'
  );
  if (res.status !== 201) throw new Error(`预置参考书失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** 给 extract 任务配置可解析的路由（供应商 + 启用） */
export async function configureExtractRoute(request: TestEnv['request']): Promise<void> {
  const provider = await seedProvider(request, { name: '抽取供应商' });
  const res = await request.put('/api/settings/routes/extract', {
    providerId: provider.id,
    model: 'extract-model',
    enabled: true,
  });
  if (res.status !== 200) throw new Error(`配置 extract 路由失败：${res.status} ${JSON.stringify(res.body)}`);
}

import type { ChatResult } from '../src/llm/types';

/** 把抽取条目包装成 FakeLLM 的脚本化响应 */
export function extractResult(items: unknown): ChatResult {
  return { content: JSON.stringify({ materials: items }), model: 'fake-extract' };
}

/** 抽取条目 JSON 形状与 server 的 ExtractionItemRecord 同构 */
export type TestExtractionItem = import('../src/references/store').ExtractionItemRecord;

/** 获取某本参考书的抽取确认队列（可按状态过滤） */
export async function extractQueue(
  request: TestEnv['request'],
  referenceId: number,
  status?: 'pending' | 'accepted' | 'rejected'
): Promise<{ items: TestExtractionItem[]; total: number }> {
  const res = await request.get(`/api/references/${referenceId}/extractions${status ? `?status=${status}` : ''}`);
  if (res.status !== 200) throw new Error(`获取抽取队列失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
