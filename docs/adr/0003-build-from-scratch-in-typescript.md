# 从零自建全 TypeScript 栈，自研章级管线；不 fork 底座、不上编排框架

调研发现最完整的开源底座 show-me-the-story（MIT，Go+Svelte）管线/伏笔/断点续跑全齐，但我们 fork 它的改造成本高于自建收益：域模型差异大（素材四类、8 维确定性检测、闭环校正、作者偏好档案它没有或不同），且 Go+Svelte 对我们是陌生栈。同时业界横评结论：长篇连载是"按章计费、断点续跑的批处理"，确定的章级状态机 + 直连 LLM API 优于自由 ReAct agent，也轻于 LangGraph 类编排框架。因此：Vue 3 + Vite + Node（Hono/Fastify）+ SQLite 从零自建，管线为自研五阶段状态机，show-me-the-story 降级为架构参考（其 schema 设计可借鉴），webnovel-writer（GPL）/AI_NovelGenerator（AGPL）只借鉴设计不抄代码。

## Consequences

- LLM 调用走自写的 OpenAI 兼容适配层（base_url/key/model 三件套），按任务路由不同模型
- 中文分词用 Node 原生 Intl.Segmenter，不引入 Python/jieba
- License 纪律：借鉴 GPL/AGPL 项目时只看设计，不复制代码
