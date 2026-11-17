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

  // v2：素材库（T2）——四类素材 + 标签 + FTS5 中文全文检索（ADR-0002：FTS5/BM25 起步）
  // search_text 由应用层用 Intl.Segmenter 预分词（空格连接），供 unicode61 分词器的 FTS5 使用
  `
  CREATE TABLE materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('setting', 'trope', 'style', 'skeleton')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    source_kind TEXT NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual', 'reference')),
    source_book TEXT NOT NULL DEFAULT '',
    source_chapter TEXT NOT NULL DEFAULT '',
    search_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX idx_materials_type ON materials(type);
  CREATE INDEX idx_materials_updated_at ON materials(updated_at DESC);

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE material_tags (
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (material_id, tag_id)
  );

  CREATE VIRTUAL TABLE materials_fts USING fts5(search_text, content='materials', content_rowid='id');

  CREATE TRIGGER materials_fts_ai AFTER INSERT ON materials BEGIN
    INSERT INTO materials_fts(rowid, search_text) VALUES (new.id, new.search_text);
  END;

  CREATE TRIGGER materials_fts_ad AFTER DELETE ON materials BEGIN
    INSERT INTO materials_fts(materials_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
  END;

  CREATE TRIGGER materials_fts_au AFTER UPDATE ON materials BEGIN
    INSERT INTO materials_fts(materials_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
    INSERT INTO materials_fts(rowid, search_text) VALUES (new.id, new.search_text);
  END;
  `,
];
