import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema';

export type DB = Database.Database;

/** 打开（必要时创建）SQLite 库文件并执行迁移 */
export function openDatabase(filePath: string): DB {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const script = MIGRATIONS[version];
    if (script === undefined) break;
    db.transaction(() => {
      db.exec(script);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
