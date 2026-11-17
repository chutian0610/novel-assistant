import type { DB } from '../db/open';
import type { ResolvedRoute, TaskType } from './types';

interface RouteJoinRow {
  provider_id: number | null;
  provider_name: string | null;
  base_url: string | null;
  api_key: string | null;
  provider_model: string | null;
  provider_enabled: number | null;
  route_model: string;
  route_enabled: number;
}

/**
 * 按任务类型解析生效的供应商配置。
 * 路由未指派、路由停用或供应商停用时返回 null（视为不可用）。
 * 生效模型：路由覆写（route.model 非空）优先，否则取供应商默认模型。
 */
export function resolveRoute(db: DB, task: TaskType): ResolvedRoute | null {
  const row = db
    .prepare(
      `SELECT p.id AS provider_id, p.name AS provider_name, p.base_url, p.api_key,
              p.model AS provider_model, p.enabled AS provider_enabled,
              r.model AS route_model, r.enabled AS route_enabled
       FROM llm_task_routes r
       LEFT JOIN llm_providers p ON p.id = r.provider_id
       WHERE r.task = ?`
    )
    .get(task) as RouteJoinRow | undefined;

  if (!row || row.provider_id === null || row.provider_enabled !== 1 || row.route_enabled !== 1) {
    return null;
  }
  if (row.provider_name === null || row.base_url === null || row.provider_model === null || row.api_key === null) {
    return null;
  }
  return {
    providerId: row.provider_id,
    providerName: row.provider_name,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: row.route_model || row.provider_model,
  };
}
