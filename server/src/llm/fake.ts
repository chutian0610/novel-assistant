import type { ChatRequest, ChatResult, LLMProvider, TaskType } from './types';

export interface FakeLLMCall {
  task: TaskType;
  req: ChatRequest;
}

export interface FakeLLMScript {
  /** 按任务脚本化响应（返回值或抛出的错误）；未脚本化的任务返回默认结果 */
  respond?: Partial<Record<TaskType, ChatResult | Error>>;
}

/**
 * 测试范式的注入假实现（spec：唯一 mock 点 = LLMProvider 接缝）。
 * 记录每次调用供测试断言，其余一切（HTTP、SQLite）都用真实实现。
 */
export class FakeLLM implements LLMProvider {
  readonly calls: FakeLLMCall[] = [];

  constructor(private readonly script: FakeLLMScript = {}) {}

  async complete(task: TaskType, req: ChatRequest): Promise<ChatResult> {
    this.calls.push({ task, req });
    const scripted = this.script.respond?.[task];
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;
    return { content: `fake:${task}`, model: 'fake-model' };
  }
}
