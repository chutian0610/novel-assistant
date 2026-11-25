# 架构总览

本文描述 novel-assistant 的系统结构：模块地图、章节管线数据流、LLM 接缝、检索与向量、数据模型与架构纪律。领域词汇以 [`CONTEXT.md`](../CONTEXT.md) 术语表为准，关键选型的"为什么"见 [`docs/adr/`](adr/)（可配置混合管线、结构化事实库优先、全 TypeScript 从零自建、Hono 选型四篇）。

端点级细节见 [`docs/api.md`](api.md)，改代码的约定见 [`docs/dev-guide.md`](dev-guide.md)。

## 系统总览

后端为同仓 Vue 3 SPA 提供纯 JSON API，前后端只有一个进程边界：

```
浏览器 (Vue 3 SPA, hash 路由)
   │  /api/*  JSON
   ▼
Hono 应用  server/src/app.ts        ← 唯一路由装配点
   │  requestLogger / errorHandler 全局中间件
   ▼
HTTP 路由层  server/src/api/*.ts    ← zod 校验 + HttpError 映射
   ▼
领域层  server/src/<域>/*.ts        ← store 单表操作，跨表事务由上层编排
   ▼
SQLite (better-sqlite3, WAL)  server/src/db/
```

- **启动链路**（`server/src/index.ts`）：`openDatabase` → `createRoutedProvider(db)` → `createApp({ db, llm })` → 监听 `PORT`；若存在 `WEB_DIST/index.html` 则同进程静态托管前端构建产物（hash 路由，无需 SPA fallback）。
- **依赖注入**：`AppDeps = { db, llm }`（`server/src/app.ts`）贯穿全部路由。`llm` 是测试接缝——生产注入 `createRoutedProvider(db)`，测试注入 `FakeLLM`。
- **两种运行形态**：
  - 开发：`npm run dev` 同时起后端（tsx watch，:8788）与 vite（:5173），`/api` 与 `/health` 代理到 `BACKEND_ORIGIN`；
  - 生产：`npm start` 构建 web 后单进程托管，访问 `:8788`。

## 模块地图

`server/src` 各领域模块（除 `api/` 为 HTTP 层外，每个目录是一个领域，内含 store 或纯函数）：

| 模块 | 职责 | 关键文件 |
| --- | --- | --- |
| `db/` | 打开 SQLite（WAL + 外键），按 `user_version` 顺序执行只追加的迁移脚本数组 | `db/open.ts`、`db/schema.ts`（18 版迁移） |
| `llm/` | 全服务唯一的 LLM 出口：接口、任务路由解析、OpenAI 兼容 HTTP 适配、测试假实现、宽容 JSON 解析 | `llm/types.ts`、`resolver.ts`、`routed.ts`、`openai.ts`、`fake.ts`、`parse.ts` |
| `api/` | Hono 路由层（15 组路由），zod 参数校验、领域错误→HTTP 状态码 | `api/*.ts`；通用件 `errors.ts`、`validate.ts`、`middleware.ts`、`material-patch.ts` |
| `books/` | 书架与书契约（题材/基调/承诺）；书内素材引用 = 全局素材 + 覆写补丁，不回写全局素材库 | `books/store.ts` |
| `materials/` | 四类素材（设定卡/桥段/文风样本/书骨骼）+ 标签 + FTS5 中文全文检索 | `materials/store.ts`、`materials/search.ts` |
| `facts/` | 事实系统（ADR-0002）：角色运行时/人物关系/时间轴/伏笔账本；人工 CRUD + 落稿自动回灌（整章替换幂等） | `facts/store.ts`、`facts/extract-facts.ts` |
| `outlines/` | 两级大纲（卷纲→章纲），章纲状态机 draft→approved→locked；LLM 一次提出多个展开方案 | `outlines/store.ts`、`outlines/expand.ts` |
| `pipeline/` | 章节管线五阶段状态机、断点续跑持久层、verify→fix 闭环、全自动连跑、预设配置 | `pipeline/run.ts`、`verify.ts`、`store.ts`、`batch.ts`、`config.ts` |
| `detectors/` | 8 维确定性"机器味"检测器（纯函数，不经 LLM）：3-gram 复读/句长 CV/MATTR/模板套话/标点 CV/对白比/情绪密度/语义平滑度 | `detectors/metrics.ts`、`config.ts` |
| `radar/` | 爽点雷达：commit 后评测爽点标注与章末钩子、连续压抑预警；只观测不设闸门 | `radar/analyze.ts`、`store.ts` |
| `embeddings/` | `doc_embeddings` 唯一访问层：素材向量 + 正文块向量；L2 归一化 Float32 BLOB，按 model 隔离；失败不阻塞写路径 | `embeddings/store.ts` |
| `packing/` | 预算装填：为指定章构造注入视图，6 个固定分层，必带层不截断、相关性层混合装填排序后按预算截断 | `packing/pack.ts`、`tokens.ts` |
| `references/` | 拆书：txt/epub 上传解码分章 → 逐章 LLM 抽取（断点续跑）→ 确认队列 → 入库素材带出处溯源 | `references/split.ts`、`extract.ts`、`store.ts` |
| `chapterblocks/` | 正文段落切块（确定性纯函数，200 字目标块长起）+ 跨章自相似扫描 + 呼应检索 | `chapterblocks/blocks.ts`、`similarity.ts` |
| `export/` | 全书/分卷导出 txt/markdown，只导出已落稿章 | `export/exporter.ts` |
| `profile/` | 作者偏好档案（全局单例）：主题偏好 + 创作禁区 + 文风样本引用，常驻装填必带层 | `profile/store.ts` |
| `lang/` | 中文分词工具（Node 原生 `Intl.Segmenter`，不引入分词库），素材检索与检测器共用 | `lang/segment.ts` |

前端 `web/src`：`api.ts` 是通用薄封装（JSON fetch + `ApiError` + 原始 body 上传 + 纯文本下载），不硬编码端点；`pages/` 13 个页面对应界面路由，`components/` 为可复用编辑器/卡片；`types.ts` 是后端类型的镜像副本（见[同步纪律](dev-guide.md#同步纪律)）。

## 章节管线

核心实现：执行器 `pipeline/run.ts`、闭环与闸门 `pipeline/verify.ts`、持久层 `pipeline/store.ts`、连跑 `pipeline/batch.ts`、预设 `pipeline/config.ts`；API 入口 `POST /api/books/:id/chapters/:idx/generate`。

### 状态机与落盘契约

`pipeline_runs` 按（书，章号）唯一，`stage` 记录**下一个待执行阶段**（prepare/draft/verify/fix/commit/done），`status` 为 running/done/failed/suspended。核心契约：**每阶段产物先落盘再推进**——prepare 落注入视图 JSON、draft 落正文、verify 落双报告、fix 每轮重写落新草稿并清报告。这是断点续跑的基础。

| 阶段 | 做什么 |
| --- | --- |
| prepare | 前置校验：章 N 必须命中一条 approved/locked 的章纲（按大纲树顺序定位，否则 409）；随后 `buildInjectionView`（`packing/pack.ts`）构造注入视图落盘 |
| draft | 用 draft 任务路由生成正文（temperature 0.8，maxTokens 8192，要求只输出正文）；空正文视为失败 |
| verify | 出**双报告**：① 8 维确定性检测（`detectors/metrics.ts` 纯函数）；② LLM 语义核查（verify 路由，对照事实四表找矛盾）。指标 upsert 进 `chapter_metrics` |
| fix | 定向重写：对不达标维度定位问题句（span 并集合并为段），从后往前逐段调 draft 路由重写（带前后文保文风）；每轮 `fixRounds+1`、清双报告、退回 verify 复检。默认最多 2 轮（`MAX_FIX_ROUNDS`） |
| commit | 单事务原子写 chapters + 章节快照（source=pipeline）+ run 终态；随后三条互不阻塞的旁路（见下） |

### commit 后的三条旁路

commit 之后依次触发，**各自失败不阻塞提交**，均可手动重灌：

1. **事实回灌**（extract 路由）：从落稿正文抽取事实四表，整章替换幂等；失败落 `extract_error`，手动重灌入口 `POST /api/books/:id/chapters/:idx/extract`；
2. **爽点雷达回灌**（analyze 路由）：爽点标注 + 章末钩子评级落 `radar_marks`；失败落 `radar_error`，重灌入口 `POST /api/books/:id/chapters/:idx/radar`；
3. **正文块向量同步**：切块后逐块嵌入、整章替换；失败静默，重建入口 `POST /api/books/:id/chapter-blocks/reindex`。

章节被人工 PATCH 编辑或 revert 后同样重灌（事实清除、指标重算、块向量重灌）。

### 闸门与挂起

verify→fix 闭环之后是闸门（`pipeline/verify.ts` runGate + `pipeline_suspensions` 表）：

- **检测闸门**：不达标先走 fix 轮；轮次用尽后看当前轮挂起项——有 pending 即 `status=suspended`，等待人工裁决；全部裁决（ignore/fact）视作放行；无项则按句级证据逐维建项挂起。
- **语义闸门**（串行在检测闸门后）：LLM 核查出的冲突按原文摘录对账，已裁决的摘录不重建，冲突消失的 pending 自动消除。
- **恢复入口**：`server/src/api/suspensions.ts`——一键定向重写（按挂起项定位重写一轮后复检，可能直接 commit）与一键裁决（ignore/fact）。
- **编辑守卫**：run 未 done 时拒绝章节 PATCH 编辑与 revert（`assertRunSettled`），防止续跑覆盖人工修改。

### 断点续跑与批量连跑

- 进程中断/失败后再次调用 generate，已落盘产物的阶段直接跳过（LLM 不重复调用、装填不重复计算）；已 done 的章再次生成 = run 归零全新重跑。
- 全自动连跑（`pipeline/batch.ts`）仅 auto 预设可用（协作模式 409）：从工作前沿第一个未落稿章连跑，至 `auto_run_limit`（默认 5）停止；停止原因 limit/suspended/error/precondition/none。协作/全自动是同一管线的两个预设（ADR-0001），预设存于 `pipeline_configs` 键值表。

## LLM 接缝

`LLMProvider { complete(task, req); embed(req) }`（`llm/types.ts`）是代码中唯一的 LLM 出口，按 6 类任务路由：**outline / draft / extract / verify / embed / analyze**。

| 文件 | 角色 |
| --- | --- |
| `llm/types.ts` | 接缝本体：接口、TaskType、ResolvedRoute、LLMError |
| `llm/resolver.ts` | `resolveRoute(db, task)`：JOIN 任务路由 × 供应商表；未指派/停用返回 null（不可用）；生效模型 = 路由覆写优先，否则供应商默认模型 |
| `llm/routed.ts` | 生产实现：按 task 解析路由后发起调用；未配置抛 `RouteNotConfiguredError`（API 层映射 409） |
| `llm/openai.ts` | 全服务唯一网络出口：chat/completions 与 /embeddings 裸 fetch（30s 超时） |
| `llm/fake.ts` | 测试注入：记录每次调用供断言，script 支持按任务/按顺序脚本化；embed 返回确定性伪向量 |
| `llm/parse.ts` | `parseLooseJson`：所有 LLM JSON 响应共用的宽容剥壳 |

供应商与任务路由配置存于 `llm_providers` / `llm_task_routes` 表（设置页维护，见 `api/settings.ts`）。每次调用实时解析路由，**运行时切换供应商即时生效，无需重启**。

## 检索与向量

预算装填的相关性选材采用**混合装填**（`packing/pack.ts`，V2/V3 演进自 ADR-0002 的"检索为辅"）：

- **双路召回**：词面走 FTS5 BM25（`materials/search.ts`，`Intl.Segmenter` 预分词），语义走 `doc_embeddings` 向量；
- **融合**：两路名次 RRF 融合（`RRF_K = 60`）→ 按 token 预算截断（`packing/tokens.ts`）；装填预览标注双路名次；
- **降级是合法形态**：embed 路由未配置时自动退回纯词面排序，不改变装填语义；
- **正文块向量**（V3）：落稿章切块后向量入库，支撑跨章自相似查重（O(n²) 余弦扫描，排除相邻窗口）与呼应检索（查询句 → 全书相似旧段 top-K）；
- **核心不变量**：向量索引只用于检索排序增强（装填相关性、呼应旧章、跨章自相似），**永不做一致性数据源**——一致性以带溯源的结构化事实库为准（ADR-0002）。

模块协作：`references → materials/embeddings`（抽取入库同步向量）；`packing → {books, outlines, facts, profile, materials, embeddings, …}`（装填是最大汇聚点）；`pipeline → packing`（prepare 阶段产出注入视图）；`pipeline/chapterblocks → embeddings`（commit 旁路与编辑后重灌）；`radar ↔ pipeline`（雷达是 commit 旁路产物，反向读章节列表与预警窗口配置）。`embeddings` 是唯一直接调用 embed 路由的领域模块，其余模块只消费它存好的向量。

## 数据模型

SQLite 单库（`data/` 运行时不入库），迁移脚本数组只追加（`db/schema.ts`，现 18 版）。核心表按域分组：

| 域 | 表 | 要点 |
| --- | --- | --- |
| LLM 配置 | `llm_providers`、`llm_task_routes` | 任务路由外键 ON DELETE SET NULL；删供应商不停路由 |
| 素材 | `materials`、`tags`、`material_tags`、FTS5 虚表 `materials_fts` | contentless FTS5，触发器同步；search_text 应用层预分词 |
| 书 | `books`、`book_materials` | 书契约字段 genre/tone/promise；覆写补丁存 overrides，遮蔽同名字段 |
| 拆书 | `reference_books`、`reference_chapters`、`extraction_items` | 分章落盘；条目 status pending/accepted/rejected，resolution new/merge/skip |
| 大纲 | `volumes`、`chapter_outlines` | 章号 = 大纲树顺序，无显式章号字段；状态机 draft→approved→locked |
| 事实四表 | `character_states`、`character_relations`、`timeline_events`、`foreshadows` | 全部挂书、带来源章 + 原文证据 + origin(manual/auto)；伏笔带状态机与埋设/目标章 |
| 管线 | `chapters`、`chapter_snapshots`、`pipeline_runs`、`chapter_metrics`、`pipeline_suspensions` | 正文/滚动摘要/版本快照/逐章指标/挂起项；runs 保存各阶段产物 |
| 配置与观测 | `detector_configs`、`pipeline_configs`、`author_profile`、`radar_marks`、`doc_embeddings` | 键值配置 + 单例作者偏好档案 + 雷达标注 + 向量 BLOB（按 model 隔离） |

## 架构纪律

**测试强制**（`server/test/architecture.test.ts` 静态扫描）：除白名单 `llm/openai.ts` 外，任何 `server/src` 源文件不得出现 `fetch(`、`from 'openai'`、`axios`、`undici`——固化"代码中除 LLMProvider 外无任何直连 LLM 的调用"；并有反向校验（白名单文件必须确实包含 `fetch(`，防止出口被挪走导致纪律落空）。这是当前唯一由测试强制的纪律。

**惯例纪律**（代码注释与测试范式明示，靠 review 维持）：

- 迁移脚本只追加不修改（`db/schema.ts` 头注）；SQLite 不能改 CHECK 约束时用建新表搬迁的手法；
- store 层只做单表操作，跨表事务由上层编排（`pipeline/store.ts`）；
- LLM 只产文本不产坐标——span/位置一律由应用层定位计算（radar/verify）；
- 测试范式：LLM 接缝注入 FakeLLM，从 HTTP API 打进（supertest），真实 SQLite 临时库，除 LLMProvider 外不 mock（`server/test/helpers.ts`）；
- 领域输出使用 [`CONTEXT.md`](../CONTEXT.md) 术语表的词汇，不用其 Avoid 词（见 [`docs/agents/domain.md`](agents/domain.md)）。
