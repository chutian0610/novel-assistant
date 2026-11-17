import { expect, it } from 'vitest';
import { openDatabase } from '../src/db/open';
import { resolveRoute } from '../src/llm/resolver';
import type { TaskType } from '../src/llm/types';
import { createTestApp } from './helpers';

function setup() {
  const { db } = createTestApp();
  const insertProvider = db.prepare(
    'INSERT INTO llm_providers (name, base_url, api_key, model, enabled) VALUES (?, ?, ?, ?, ?)'
  );
  const insertRoute = db.prepare('UPDATE llm_task_routes SET provider_id = ?, model = ?, enabled = ? WHERE task = ?');
  return { db, insertProvider, insertRoute };
}

it('合并路由覆写与供应商配置；覆写为空时回退供应商默认模型', async () => {
  const { db, insertProvider, insertRoute } = setup();
  const providerId = Number(
    insertProvider.run('旗舰', 'https://api.example.com/v1', 'sk-x', 'flagship-x', 1).lastInsertRowid
  );
  insertRoute.run(providerId, '', 1, 'outline');
  insertRoute.run(providerId, 'override-m', 1, 'draft');

  expect(resolveRoute(db, 'outline')).toEqual({
    providerId,
    providerName: '旗舰',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-x',
    model: 'flagship-x',
  });
  expect(resolveRoute(db, 'draft')?.model).toBe('override-m');
});

it('路由未指派、路由停用或供应商停用时返回 null', async () => {
  const { db, insertProvider, insertRoute } = setup();
  const providerId = Number(insertProvider.run('甲', 'https://a.example.com', 'k', 'm', 1).lastInsertRowid);
  const disabledProviderId = Number(insertProvider.run('乙', 'https://b.example.com', 'k', 'm', 0).lastInsertRowid);

  expect(resolveRoute(db, 'extract')).toBeNull(); // 未指派
  insertRoute.run(disabledProviderId, '', 1, 'extract');
  expect(resolveRoute(db, 'extract')).toBeNull(); // 供应商停用
  insertRoute.run(providerId, '', 1, 'verify');
  insertRoute.run(providerId, '', 0, 'outline');
  expect(resolveRoute(db, 'outline')).toBeNull(); // 路由停用
  expect(resolveRoute(db, 'verify')).not.toBeNull();
  expect(resolveRoute(db, 'draft' satisfies TaskType)).toBeNull(); // 未指派的任务
});
