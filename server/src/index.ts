import fs from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { openDatabase } from './db/open';
import { createRoutedProvider } from './llm/routed';

// 相对路径均以仓库根为工作目录（npm scripts 已保证）
const port = Number(process.env.PORT ?? 8788);
const dbPath = process.env.DB_PATH ?? 'data/novel-assistant.sqlite';
const webDist = process.env.WEB_DIST ?? 'web/dist';

const db = openDatabase(dbPath);
const llm = createRoutedProvider(db);
const app = createApp({ db, llm });

// 生产模式托管前端构建产物；前端使用 hash 路由，无需 SPA fallback
if (fs.existsSync(`${webDist}/index.html`)) {
  app.use('*', serveStatic({ root: webDist }));
}

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`novel-assistant 后端已启动：http://localhost:${info.port}`);
  console.log(`数据库文件：${dbPath}`);
});

function shutdown(): void {
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
