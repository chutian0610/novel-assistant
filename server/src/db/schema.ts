/**
 * 迁移脚本列表：MIGRATIONS[v] 执行后 user_version 升到 v+1。
 * 已发布的脚本不可修改，只允许追加新版本。
 */
export const MIGRATIONS: readonly string[] = [
  // v1：LLM 供应商与任务路由（T1）
  `
  CREATE TABLE llm_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE llm_task_routes (
    task TEXT PRIMARY KEY CHECK (task IN ('outline', 'draft', 'extract', 'verify')),
    provider_id INTEGER REFERENCES llm_providers(id) ON DELETE SET NULL,
    model TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  INSERT OR IGNORE INTO llm_task_routes (task) VALUES ('outline'), ('draft'), ('extract'), ('verify');
  `,
];
