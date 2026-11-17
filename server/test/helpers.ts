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
