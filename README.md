# novel-assistant

一个自动生成小说的 agent 工作台：管理素材、从已有小说提取素材、基于素材生成长篇连载小说。定位为「人主导、AI 执行」的可配置混合管线（见 `CONTEXT.md` 与 `docs/adr/`）。

当前进度：V1–V3 均已全部落地（V1 T1–T14：素材库/拆书提取/两级大纲/章节管线/闭环检测/事实系统/批量队列/导出；V2 T15–T18：前文摘要层/embedding 混合装填（ollama 本地模型优先）/爽点雷达；V3 T19–T21：正文向量语义呼应——跨章自相似查重与呼应检索）。后续工单见 GitHub Issues。

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
server/              # Node 后端（Hono + SQLite）
  src/api/           #   HTTP 路由（15 组，挂载见 src/app.ts）
  src/<域>/          #   业务领域模块：materials / books / facts / outlines / pipeline /
                     #   detectors / radar / embeddings / packing / references /
                     #   chapterblocks / export / profile / lang
  src/llm/           #   LLMProvider 接缝（代码中唯一 LLM 出口）
  src/db/            #   SQLite 接入与只追加迁移
  src/index.ts       #   入口：启动服务，生产模式托管 web/dist
  test/              #   supertest + 真实 SQLite 临时库 + 架构纪律测试
web/                 # Vue 3 前端
  src/pages/         #   页面（13 个：书架 / 写作台 / 大纲 / 事实 / 报告 / 拆书 / 素材 / 设置等）
  src/components/
  src/api.ts         #   通用请求薄封装
docs/                # 文档体系（见下「文档」一节）
data/                # 运行时 SQLite 数据（gitignore，不入仓库）
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [CONTEXT.md](CONTEXT.md) | 领域术语表（素材 / 事实 / 管线 / 爽点雷达等词条，含 Avoid 词约定） |
| [docs/architecture.md](docs/architecture.md) | 架构总览：模块地图、章节管线数据流、LLM 接缝、检索与向量、数据模型 |
| [docs/api.md](docs/api.md) | API 参考：全部 HTTP 端点速查与通用约定 |
| [docs/dev-guide.md](docs/dev-guide.md) | 开发指南：分层约定、测试范式、常见改动怎么落、同步纪律 |
| [docs/adr/](docs/adr/) | 架构决策记录（可配置混合管线 / 结构化事实库 / 从零自建 / Hono 选型） |
| [docs/agents/](docs/agents/) | Agent 协作约定（issue 工单 / triage 标签 / 领域文档消费方式） |
| [docs/research/](docs/research/) | 立项调研存档（开源 AI 写作项目横评） |

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
