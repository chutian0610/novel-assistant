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

// 素材四类：与 server/src/materials/store.ts 为镜像副本，增删类型须两处同步
export type MaterialType = 'setting' | 'trope' | 'style' | 'skeleton';

export const MATERIAL_TYPE_LABELS: Record<MaterialType, string> = {
  setting: '设定卡',
  trope: '桥段',
  style: '文风样本',
  skeleton: '书骨骼',
};

export interface MaterialSource {
  kind: 'manual' | 'reference';
  book: string;
  chapter: string;
}

export interface Material {
  id: number;
  type: MaterialType;
  title: string;
  content: string;
  payload: Record<string, string>;
  tags: string[];
  source: MaterialSource;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialListResponse {
  items: Material[];
  total: number;
}

export interface TagCount {
  name: string;
  count: number;
}
