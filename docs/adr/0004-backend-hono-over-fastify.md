# 后端 HTTP 层选 Hono，不选 Fastify

T1 落地全栈骨架时需要定夺 Node 后端框架（spec 留白：Hono 或 Fastify，本单内定夺并记录）。我们决定：**Hono + `@hono/node-server`**（跑在 Node 上，不是边缘运行时）。

## Why

- **原生 TypeScript 体验**：Hono 类型化彻底（context、status 字面量类型、错误处理），无装饰器/插件体系的心智负担；Fastify 的 JSON Schema 校验体系与 TS 泛型推导对单人项目偏重。
- **测试范式无缝**：本项目测试纪律是「supertest 从 HTTP API 打进」。`getRequestListener(app.fetch)` 直接把 Hono handler 适配成 Node http handler，supertest 零包装接入（注意：须传 `app.fetch` 而非 app 实例）。
- **轻量**：依赖树极小；静态托管（`serveStatic`）内建，生产模式单进程同时服务 API 与前端构建产物。
- **校验解耦**：请求体校验用 zod 在 handler 内完成，不绑定框架 schema 机制，未来换框架迁移面小。

## Considered Options

- **Fastify**：成熟、插件生态全、性能强——被否，对当前规模 TS 体验与轻量性收益不抵学习/胶水成本。
- **Express**：被否，无原生 async 支持、类型化弱、维护放缓。

## Consequences

- 校验错误统一经 `HttpError`（handler 内 zod `safeParse`）转 JSON；框架不感知 schema。
- 请求日志/错误处理为两个极简中间件，不引入 pino 等日志库。
- dev 模式 vite 代理 `/api` 与 `/health` 到后端；生产模式 Hono 托管 `web/dist`（前端 hash 路由，无需 SPA fallback）。
