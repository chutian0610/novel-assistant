import type { DB } from '../db/open';
import { chatCompletion } from './openai';
import { resolveRoute } from './resolver';
import type { ChatRequest, ChatResult, LLMProvider, TaskType } from './types';

export class RouteNotConfiguredError extends Error {
  constructor(task: TaskType) {
    super(`任务「${task}」尚未配置可用的模型路由（缺供应商或已停用）`);
    this.name = 'RouteNotConfiguredError';
  }
}

/** 生产实现：从 SQLite 解析任务路由，经唯一网络出口调用 OpenAI 兼容服务 */
export function createRoutedProvider(db: DB): LLMProvider {
  return {
    async complete(task: TaskType, req: ChatRequest): Promise<ChatResult> {
      const route = resolveRoute(db, task);
      if (!route) throw new RouteNotConfiguredError(task);
      return chatCompletion(route, req);
    },
  };
}
