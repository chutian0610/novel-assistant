# 开发指南

面向要改这份代码的人（人或 agent）：项目布局与分层约定、测试范式、常见改动怎么落、跨端同步纪律。系统"怎么运作"见 [`docs/architecture.md`](architecture.md)，端点清单见 [`docs/api.md`](api.md)。

## 项目布局与分层

```
server/src/
  index.ts        # 入口：openDatabase → createRoutedProvider → createApp → 监听
  app.ts          # 唯一路由装配点：app.route 挂载各路由组 + 全局中间件
  api/            # HTTP 层：zod 校验、HttpError 映射，不含业务逻辑
  <域>/           # 业务层：每目录一个领域，store 单表操作 + 纯函数
  db/             # SQLite 接入（WAL + 外键）与只追加迁移
  llm/            # LLMProvider 接缝（代码中唯一 LLM 出口）
web/src/
  api.ts          # 通用薄封装（JSON fetch / postRaw / getText），不硬编码端点
  pages/          # 页面组件（13 个），负责拼装端点 URL
  components/     # 可复用编辑器与卡片
  types.ts        # 后端类型的镜像副本（见「同步纪律」）
  materialSchema.ts
test/             # server/test：supertest + 真实 SQLite 临时库
docs/             # 本文档体系（见 README「文档」一节）
data/             # 运行时 SQLite 数据（gitignore，不入仓库）
```

分层约定：

- **api 层只做协议**：解析/校验请求（`api/validate.ts` 的 `parseBody` / `parseId` / `parseQueryInt`）、调用领域层、把领域错误翻译成 HTTP 状态码。业务错误用 `HttpError(status, message)`（`api/errors.ts`）抛出，全局 `errorHandler` 统一转 `{error}` JSON。
- **store 层只做单表操作**：跨表事务由上层（如 `pipeline/verify.ts`）编排。
- **迁移只追加**：`db/schema.ts` 的 `MIGRATIONS` 数组，已发布脚本不可修改，新变更只能追加新版本；SQLite 不能改 CHECK 约束时用建新表搬迁的手法。
- **LLM 只经接缝**：任何需要调 LLM 的地方注入 `LLMProvider`，禁止直接 fetch（见「架构纪律」）。

## 测试范式

spec 规定，四条（`server/test/helpers.ts` 头注原文）：

1. **LLM 接缝注入 FakeLLM** —— 唯一 mock 点；
2. **从 HTTP API 打进**（supertest），不直接调 store 函数；
3. **真实 SQLite 临时库**（`mkdtemp` 建临时目录，afterEach 清理）；
4. **除此之外不 mock 任何东西**。

### 起手写法

```ts
import { expect, it } from 'vitest';
import { createTestApp } from './helpers';

it('GET /health 返回 ok', async () => {
  const { request } = createTestApp();
  const res = await request.get('/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });
});
```

- `createTestApp(llm?)` 返回 `{ db, llm, request }`；`request` 封装 get/post/patch/put/delete（自动 send JSON body）与 `postRaw`（原始 body，上传接口用）。不传 llm 时默认注入 `new FakeLLM()`；传的话**必须**是 FakeLLM 实例（范式守卫）。
- 预置数据一律走 API 而非直接插库：`helpers.ts` 提供 `seedProvider` / `seedMaterial` / `seedBook` / `seedBookMaterial` / `seedReference` / `seedVolume` / `seedChapterOutline` / `seedCharacterState` 等系列；类型直接复用 server 端 Record 类型保持同构。
- 需要某任务路由可解析时用 `configureRoute(request, task)`（建供应商 + 启用路由）。

### FakeLLM 脚本化

```ts
const llm = new FakeLLM({
  respond: { extract: extractResult([...]) },          // 按任务固定响应
  respondSequence: { draft: [a, b, c] },               // 按调用顺序弹出（多轮场景）
  embed: { vectors: [...], model: 'fake-embed' },      // 向量化脚本；缺省给确定性伪向量
});
```

- `llm.calls` / `llm.embedCalls` 记录每次调用，供断言"确实用了某任务路由/提示词"。
- `script` 公开可变，可在流程中途改写（断点续跑的分段脚本就是这么测的）。
- 缺省伪向量是字符 2-gram + djb2 哈希（`FAKE_EMBED_DIM = 64`），同文本恒同向量，装填排序/索引类测试可做可预测断言。
- LLM 返回 JSON 的场景用 `llm/parse.ts` 的宽容格式包装（见 helpers 里的 `extractResult` / `outlineResult`）。

跑法：`npm test`（全量）/ `npm run test:watch`；`npm run typecheck` 全仓类型检查。

## 常见改动指南

### 加一组 HTTP 路由

1. 在 `server/src/api/<域>.ts` 建 `Hono` 子路由，zod schema 校验入参（复用 `validate.ts`）；
2. 业务错误抛 `HttpError`；领域层已定义的专用错误（如 `RouteNotConfiguredError`）在 api 层 instanceof 映射状态码；
3. 在 `server/src/app.ts` 挂载（多数组直接 `app.route('/api', xxxRoutes(deps))`；有子前缀的像 settings 一样挂 `/api/settings`）；
4. 测试文件 `server/test/<域>.test.ts`，从 `createTestApp()` 打进。

### 加数据库迁移

在 `db/schema.ts` 的 `MIGRATIONS` 数组**末尾追加**一段 SQL（版本号 = 数组下标 + 1，注释写明对应工单/意图）；不改历史脚本。需要回填数据时也写在迁移 SQL 里。

### 加领域模块

新建 `server/src/<域>/` 目录：`store.ts`（单表 CRUD，返回 Record 类型）+ 按需的纯函数文件。对外类型会在 `web/src/types.ts` 有镜像副本，见下节。

### 给章节管线加配置键

管线预设存于 `pipeline_configs` 键值表，经 `pipeline/config.ts` 读写（含类型化默认值与校验）；设置端点在 `api/settings.ts` 的 `/api/settings/pipeline`，前端类型镜像在 `web/src/types.ts` 的 `PipelineSettings`。

## 同步纪律

两处**手动镜像**，改一边必须改另一边（文件头/对应段有同步注释）：

| 镜像 | 位置 |
| --- | --- |
| 后端各 store 的 Record/视图类型 ↔ 前端类型 | `server/src/*/store.ts` ↔ `web/src/types.ts` |
| 素材 payload 字段定义 | server 端 `payloadSchemas` ↔ `web/src/materialSchema.ts` |

另有一条**测试强制**的纪律（`server/test/architecture.test.ts` 静态扫描）：除 `server/src/llm/openai.ts` 白名单外，`server/src` 任何文件出现 `fetch(`、`from 'openai'`、`axios`、`undici` 即测试失败。要发起新的外部调用，加到 `openai.ts` 或经 `LLMProvider` 接缝扩展。

## 环境与启动

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8788` | 后端端口 |
| `DB_PATH` | `data/novel-assistant.sqlite` | SQLite 库文件路径（相对路径以仓库根为工作目录） |
| `WEB_DIST` | `web/dist` | 生产模式静态资源目录（存在 `index.html` 才托管） |
| `BACKEND_ORIGIN`（vite） | `http://localhost:8788` | dev 代理 `/api` 与 `/health` 的目标 |

- 开发：`npm run dev`（后端 tsx watch :8788 + vite :5173，浏览器开 5173）。
- 生产：`npm start`（构建 web + 单进程托管 :8788）。
- 端口冲突：后端 `PORT=xxxx npm run dev`，同时给 vite 设 `BACKEND_ORIGIN=http://localhost:xxxx`。
- LLM 配置不走环境变量：在设置页（`/api/settings/*`）配置供应商与任务路由，运行时切换即时生效。

## 工单与协作约定

- Issue 与规格全部放 GitHub Issues，用 `gh` CLI 操作；五个 triage 标签见 [`docs/agents/triage-labels.md`](agents/triage-labels.md)，命令模板见 [`docs/agents/issue-tracker.md`](agents/issue-tracker.md)。
- Agent 探索代码前先读 [`CONTEXT.md`](../CONTEXT.md)（术语表）与 [`docs/adr/`](adr/)；输出必须使用术语表词汇、不用 Avoid 词；与既有 ADR 冲突要显式指出——详见 [`docs/agents/domain.md`](agents/domain.md)。
- commit message 惯例：`feat(tN): 中文描述` / `docs: 中文描述`，一个工单一个 `feat/tN-*` 分支 + PR。
