import { Hono } from 'hono';
import type { DB } from './db/open';
import type { LLMProvider } from './llm/types';
import { healthRoutes } from './api/health';
import { settingsRoutes } from './api/settings';
import { materialsRoutes } from './api/materials';
import { booksRoutes } from './api/books';
import { chaptersRoutes } from './api/chapters';
import { suspensionsRoutes } from './api/suspensions';
import { metricsRoutes } from './api/metrics';
import { factsRoutes } from './api/facts';
import { detectorsRoutes } from './api/detectors';
import { outlinesRoutes } from './api/outlines';
import { packingRoutes } from './api/packing';
import { referencesRoutes } from './api/references';
import { errorHandler, requestLogger } from './api/middleware';

export interface AppDeps {
  db: DB;
  /** LLMProvider 接缝：生产为 createRoutedProvider，测试注入 FakeLLM */
  llm: LLMProvider;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use(requestLogger);
  app.onError(errorHandler);
  app.route('/', healthRoutes());
  app.route('/api/settings', settingsRoutes(deps));
  app.route('/api', materialsRoutes(deps));
  app.route('/api', booksRoutes(deps));
  app.route('/api', chaptersRoutes(deps));
  app.route('/api', suspensionsRoutes(deps));
  app.route('/api', metricsRoutes(deps));
  app.route('/api', outlinesRoutes(deps));
  app.route('/api', factsRoutes(deps));
  app.route('/api', detectorsRoutes(deps));
  app.route('/api', packingRoutes(deps));
  app.route('/api', referencesRoutes(deps));
  app.notFound((c) => c.json({ error: '接口不存在' }, 404));
  return app;
}
