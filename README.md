# novel-assistant

一个自动生成小说的 agent 工作台：管理素材、从已有小说提取素材、基于素材生成长篇连载小说。定位为「人主导、AI 执行」的可配置混合管线。

> 规划文档（`CONTEXT.md` 领域词汇表、ADR-0001~0003、issue 跟踪约定）目前在 `docs/planning` 分支，待并入 main 后可在仓库根直接查阅。

当前进度：T1 项目骨架已落地（设置页可配置 LLM 供应商与任务路由）。后续工单见 GitHub Issues。

## 技术栈

- **前端**：Vue 3 + Vite + TypeScript（hash 路由，无重型 UI 框架）
- **后端**：Node + Hono（`@hono/node-server`，选型见 `docs/adr/0004`）
- **存储**：SQLite（better-sqlite3，单库文件，运行时数据不入仓库）
- **LLM**：自写 OpenAI 兼容适配层 `LLMProvider`，按任务类型（outline/draft/extract/verify）路由到不同供应商配置；这是代码中唯一的 LLM 出口（ADR-0003）

## 快速开始

```bash
npm install
npm run dev        # 一条命令同时启动后端(:8788)与前端(:5173)
```

浏览器打开 http://localhost:5173 （自动进入设置页），配置 LLM 供应商并给各任务指派模型路由，点「测试连通」验证。

端口冲突时：后端设 `PORT=xxxx`，vite 设 `BACKEND_ORIGIN=http://localhost:xxxx`。

生产模式（单进程托管前端构建产物）：

```bash
npm start          # 构建 web + 启动服务，访问 http://localhost:8788
```

## 测试

测试范式（spec 规定）：LLM 接缝注入 FakeLLM，后端测试一律从 HTTP API 打进（supertest），使用真实 SQLite 临时库；除 LLMProvider 外不 mock 任何东西。

```bash
npm test           # 全量后端测试
npm run test:watch # watch 模式
npm run typecheck  # 服务端 tsc + 前端 vue-tsc
```

## 目录结构

```
server/          # Node 后端（Hono + SQLite）
  src/db/        #   SQLite 接入与迁移
  src/llm/       #   LLMProvider 适配层（resolver / openai 出口 / FakeLLM）
  src/api/       #   HTTP 路由（health / settings）
  src/index.ts   #   入口：启动服务，生产模式托管 web/dist
  test/          #   supertest + 真实 SQLite 临时库 + 架构纪律测试
web/             # Vue 3 前端
  src/pages/     #   页面（当前：设置页）
  src/components/
data/            # 运行时 SQLite 数据（gitignore，不入仓库）
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式（后端 tsx watch + 前端 vite，/api 代理） |
| `npm start` | 生产模式（构建前端 + 单进程托管） |
| `npm test` / `npm run test:watch` | 后端测试 |
| `npm run typecheck` | 全仓类型检查 |

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8788` | 后端端口 |
| `DB_PATH` | `data/novel-assistant.sqlite` | SQLite 库文件路径 |
| `WEB_DIST` | `web/dist` | 生产模式静态资源目录 |
| `BACKEND_ORIGIN`（vite） | `http://localhost:8788` | dev 代理的后端地址 |
