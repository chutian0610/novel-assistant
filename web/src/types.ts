// 任务类型：与 server/src/llm/types.ts 为镜像副本（前端无构建期共享包），增删任务须两处同步
export const TASK_TYPES = ['outline', 'draft', 'extract', 'verify'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_LABELS: Record<TaskType, string> = {
  outline: '大纲',
  draft: '正文',
  extract: '抽取',
  verify: '核查',
};

export interface Provider {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRoute {
  task: TaskType;
  providerId: number | null;
  providerName: string | null;
  model: string;
  enabled: boolean;
  effectiveModel: string | null;
  updatedAt: string;
}

export interface RouteTestResult {
  ok: boolean;
  latencyMs: number;
  provider: { id: number; name: string } | null;
  model: string | null;
  baseUrl: string | null;
  error?: string;
}
