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

  // v3：书架与书内素材引用（T3）。引用 + 覆写语义：book_materials.overrides 补丁遮蔽全局素材
  // 的同名字段，永不回写；书或素材删除时引用行级联清理，全局素材互不受影响
  `
  CREATE TABLE books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    genre TEXT NOT NULL DEFAULT '',
    tone TEXT NOT NULL DEFAULT '',
    promise TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX idx_books_updated_at ON books(updated_at DESC);

  CREATE TABLE book_materials (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    overrides TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (book_id, material_id)
  );

  CREATE INDEX idx_book_materials_material ON book_materials(material_id);
  `,

  // v4：拆书提取（T4）——参考书 + 章节（分章落盘，抽取按章断点续跑）+ 抽取确认队列。
  // 确认入库才写入 materials（带参考书溯源）；删除参考书级联清理章与队列，已入库素材不受影响
  `
  CREATE TABLE reference_books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('txt', 'epub')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE reference_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_id INTEGER NOT NULL REFERENCES reference_books(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    extract_status TEXT NOT NULL DEFAULT 'pending' CHECK (extract_status IN ('pending', 'done')),
    UNIQUE (reference_id, idx)
  );

  CREATE INDEX idx_reference_chapters_ref ON reference_chapters(reference_id);

  CREATE TABLE extraction_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_id INTEGER NOT NULL REFERENCES reference_books(id) ON DELETE CASCADE,
    chapter_id INTEGER NOT NULL REFERENCES reference_chapters(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('setting', 'trope', 'style', 'skeleton')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    resolution TEXT CHECK (resolution IN ('new', 'merge', 'skip')),
    material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX idx_extraction_items_ref_status ON extraction_items(reference_id, status);
  `,

  // v5：书骨骼提取与仿写（T5）——重建 extraction_items：chapter_id 改可空（全书级骨骼/仿写条目
  // 不挂具体章），新增 source_skeleton_id 记录仿写来源骨骼（仿写素材确认入库后溯源 chapter 指向它）
  `
  CREATE TABLE extraction_items_v5 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_id INTEGER NOT NULL REFERENCES reference_books(id) ON DELETE CASCADE,
    chapter_id INTEGER REFERENCES reference_chapters(id) ON DELETE CASCADE,
    source_skeleton_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN ('setting', 'trope', 'style', 'skeleton')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    resolution TEXT CHECK (resolution IN ('new', 'merge', 'skip')),
    material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  INSERT INTO extraction_items_v5
    (id, reference_id, chapter_id, source_skeleton_id, type, title, content, payload, status, resolution, material_id, created_at, updated_at)
  SELECT id, reference_id, chapter_id, NULL, type, title, content, payload, status, resolution, material_id, created_at, updated_at
  FROM extraction_items;

  DROP TABLE extraction_items;
  ALTER TABLE extraction_items_v5 RENAME TO extraction_items;

  CREATE INDEX idx_extraction_items_ref_status ON extraction_items(reference_id, status);
  `,
];
