# API 参考

后端全部 HTTP 端点速查。路由挂载以 `server/src/app.ts` 为准，各路由实现在 `server/src/api/*.ts`。请求/响应细节以各文件内的 zod schema 为准，本文只列路径、用途与特殊行为。

## 通用约定

- **base 路径**：除健康检查挂根路径外，全部端点在 `/api` 下；`settings` 组挂在 `/api/settings` 子路径，其余组直接挂 `/api`。
- **请求/响应**：JSON 为主（`content-type: application/json`）。三个例外：健康检查；导出返回纯文本；参考书上传的**请求体**是原始 txt/epub 字节（非 multipart）。
- **错误结构**：统一 `{ "error": string }`。未处理异常返回 500 `{error: "服务器内部错误"}`，未知路径返回 404 `{error: "接口不存在"}`。
- **分页**：列表端点统一返回 `{ items, total }`，query 用 `limit` / `offset`。
- **状态码语义**：

| 状态码 | 含义 | 常见触发 |
| --- | --- | --- |
| 400 | 参数错误 | zod 校验失败（消息格式 `参数 字段:消息`）、非法 JSON、参数越界 |
| 404 | 资源不存在 | 书/素材/章/条目 id 不存在 |
| 409 | 业务冲突 | 重名、章纲已锁定、LLM 任务路由未配置、协作模式下连跑、管线运行未结束、重复引用 |
| 413 | 上传超限 | 参考书 txt > 5MB / epub > 50MB |
| 502 | 上游失败 | LLM 产出无法解析为预期结构 |

- **旁路语义**：「失败不阻塞」的端点（事实回灌重灌、爽点雷达重灌）即使上游 LLM 失败也返回 200，失败信息落在运行记录或响应体内。

---

## 健康检查

实现：`api/health.ts`（挂根路径）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回 `{ok: true}` |

## 设置中心

实现：`api/settings.ts` · 前端页面：SettingsPage

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings/providers` | 列出 LLM 供应商 |
| POST | `/api/settings/providers` | 新建供应商（201） |
| PATCH | `/api/settings/providers/:id` | 部分更新供应商 |
| DELETE | `/api/settings/providers/:id` | 删除供应商（任务路由外键置空，204） |
| GET | `/api/settings/routes` | 6 类任务路由表（含联查出的生效模型） |
| PUT | `/api/settings/routes/:task` | 更新某任务的供应商/模型覆写/启停 |
| POST | `/api/settings/routes/:task/test` | 路由连通性探测（embed 任务打 /embeddings 探针） |
| GET | `/api/settings/pipeline` | 读章节管线预设（模式、连跑上限、检索参数等） |
| PUT | `/api/settings/pipeline` | 更新管线预设 |
| GET | `/api/settings/author-profile` | 读作者偏好档案（全局单例） |
| PUT | `/api/settings/author-profile` | 更新主题偏好/创作禁区/文风样本引用 |

`task` ∈ `outline / draft / extract / verify / embed / analyze`。

## 素材库

实现：`api/materials.ts` · 前端页面：MaterialsPage

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/materials` | 素材列表（query：`type` / `tag` / `q` 关键词 / `limit` / `offset`） |
| POST | `/api/materials` | 创建素材（setting/trope/style/skeleton 四类），同步向量索引 |
| GET | `/api/materials/:id` | 素材详情 |
| PATCH | `/api/materials/:id` | 部分更新（类型不可变），内容变更后重新嵌入 |
| POST | `/api/materials/embeddings/reindex` | 批量重建素材向量索引（embed 路由未配置 → 409） |
| DELETE | `/api/materials/:id` | 删除素材及其向量（204） |
| GET | `/api/tags` | 全库标签聚合计数 |

## 书架与书内素材

实现：`api/books.ts` · 前端页面：ShelfPage、BookDetailPage

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books` | 书架列表（limit/offset 分页） |
| POST | `/api/books` | 创建书（书契约：title/genre/tone/promise）（201） |
| GET | `/api/books/:id` | 书详情 |
| PATCH | `/api/books/:id` | 更新书契约元数据 |
| DELETE | `/api/books/:id` | 删除书及正文块向量（204） |
| GET | `/api/books/:id/materials` | 书内素材引用列表（含覆写合并后的生效视图） |
| POST | `/api/books/:id/materials` | 引用素材进书（body `{materialId}`；重复引用 409） |
| PATCH | `/api/books/:id/materials/:materialId` | 更新书内覆写（body `{overrides}`；空对象 = 清除全部覆写） |
| DELETE | `/api/books/:id/materials/:materialId` | 移除书内素材引用（204） |

## 章节与章节管线

实现：`api/chapters.ts` · 前端页面：WritingPage

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books/:id/chapters` | 章节列表（附每章运行状态摘要） |
| POST | `/api/books/:id/chapters/:idx/generate` | 启动/续跑单章管线 prepare→draft→verify→fix→commit；断点续跑：已落盘阶段直接跳过 |
| GET | `/api/books/:id/chapters/:idx` | 章节详情（正文 + 运行记录 + 快照列表） |
| PATCH | `/api/books/:id/chapters/:idx` | 编辑正文（管线未 done 时 409；同步重算指标、清除回灌事实、重灌块向量） |
| POST | `/api/books/:id/chapters/batch-generate` | 全自动连跑（协作预设 → 409；至连跑上限/挂起/出错停止） |
| GET | `/api/books/:id/pipeline-queue` | 批量队列视图：大纲树全位置与运行状态联表 |
| POST | `/api/books/:id/chapters/:idx/extract` | 手动事实回灌重试（仅已落稿章；失败不阻塞，返回 200） |
| POST | `/api/books/:id/chapters/:idx/revert` | 回退到指定快照（body `{snapshotId}`；run 未 done 时 409） |

章号 `idx` = 大纲树顺序号。前置校验失败（章 N 无 approved/locked 章纲）→ 409。

## 挂起队列

实现：`api/suspensions.ts` · 前端页面：SuspensionsPage

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books/:id/suspensions` | 挂起项列表（query：`status=pending`、`idx` 按章过滤） |
| POST | `/api/books/:id/chapters/:idx/suspensions/:sid/rewrite` | 一键定向重写：按挂起项重写一轮 → 复检 → 可能直接 commit |
| POST | `/api/books/:id/chapters/:idx/suspensions/:sid/resolve` | 一键裁决（body `{resolution: "ignore" \| "fact"}`） |

后两者统一响应 `{run, chapter, suspensions}`（运行状态 + 可能已落稿的章节 + 剩余 pending）。

## 指标与报告

实现：`api/metrics.ts` · 前端页面：MetricsPage

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books/:id/metrics` | 逐章检测指标趋势 |

## 两级大纲

实现：`api/outlines.ts` · 前端页面：OutlinePage、PackingPage（只读）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books/:id/outlines` | 两级大纲树（卷与其下章纲） |
| POST | `/api/books/:id/outlines/volumes` | 新建卷纲 |
| PATCH | `/api/books/:id/outlines/volumes/:volumeId` | 更新卷纲 |
| DELETE | `/api/books/:id/outlines/volumes/:volumeId` | 删除卷纲（其下章纲已锁定 → 409） |
| POST | `/api/books/:id/outlines/volumes/:volumeId/chapters` | 在卷下新建章纲 |
| PATCH | `/api/books/:id/outlines/chapters/:chapterId` | 更新章纲（locked → 409） |
| DELETE | `/api/books/:id/outlines/chapters/:chapterId` | 删除章纲 |
| POST | `/api/books/:id/outlines/chapters/:chapterId/status` | 章纲状态机迁移（draft→approved→locked；非法迁移 409） |
| POST | `/api/books/:id/outlines/chapters/:chapterId/expansions` | AI 多方案展开章纲（body 可选 `{hint}`） |

## 事实四表

实现：`api/facts.ts` · 前端页面：FactsPage

四表共用同一套 CRUD 形状（`GET` 列表 + `POST` 新建 + `PATCH` / `DELETE` 单条）：

| 资源 | 路径前缀 | 说明 |
| --- | --- | --- |
| 角色运行时 | `/api/books/:id/facts/characters` | 人物动态状态（伤势/秘密/持有物/境界等分类） |
| 人物关系 | `/api/books/:id/facts/relations` | 有向边 fromName/toName/relation |
| 时间轴 | `/api/books/:id/facts/timeline` | 事件叙事时序 |
| 伏笔账本 | `/api/books/:id/facts/foreshadows` | 状态机 planted/progressing/resolved/abandoned |

伏笔额外端点与校验：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/books/:id/facts/foreshadows/:factId/status` | 伏笔状态迁移（非法迁移 409） |

- 伏笔列表可带 `currentChapter` 判超期；伏笔 PATCH 校验埋设章 ≤ 目标章。
- 四表全部为人工维护 + 落稿自动回灌双来源，字段带 origin(manual/auto)，API 层不区分写入来源。

## 检测器

实现：`api/detectors.ts` · 前端页面：DetectorsPage、SettingsPage（阈值）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/detectors/config` | 读 8 维检测阈值 |
| PUT | `/api/detectors/config` | 更新阈值（min > max 交叉 → 400） |
| POST | `/api/detectors/analyze` | 对文本出检测报告（上限 20 万字；纯统计，不经 LLM） |

## 注入视图预览

实现：`api/packing.ts` · 前端页面：PackingPage

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books/:id/packing` | 注入视图预览：分层装填清单与 token 账目（query：`chapter` 必填，`budget` 可选） |

## 导出

实现：`api/export.ts` · 前端页面：BookDetailPage

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books/:id/export` | 导出全书/单卷纯文本（query：`format=txt\|markdown`，`volumeId` 可选；只含已落稿章，无落稿章 → 409；**响应非 JSON**） |

## 拆书提取

实现：`api/references.ts` · 前端页面：ReferencesPage、ReferenceDetailPage

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/references` | 上传参考书（query：`format=txt\|epub`，txt 必须带 `title`；**请求体为原始文件字节**：txt ≤ 5MB / epub ≤ 50MB）（201） |
| GET | `/api/references` | 参考书列表 |
| GET | `/api/references/:id` | 参考书详情（含分章结果） |
| DELETE | `/api/references/:id` | 删除参考书（204） |
| POST | `/api/references/:id/extract` | 逐章 LLM 抽取（body 可选 `chapterIds[]` / `limit` 1-20；断点续跑） |
| POST | `/api/references/:id/extract-skeleton` | 全书骨骼提取 → 确认队列（已有 pending 骨骼条目 → 409） |
| POST | `/api/references/:id/adapt-skeleton` | 一键仿写（body `{materialId}`，对已入库书骨骼生成新设定） |
| GET | `/api/references/:id/extractions` | 确认队列列表（query：`status=pending\|accepted\|rejected`） |

抽取条目处置（id 为条目 id，注意路径不带参考书前缀）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/extractions/:id` | 抽取条目详情 |
| PATCH | `/api/extractions/:id` | 修改 pending 条目（已处理 → 409） |
| POST | `/api/extractions/:id/accept` | 确认入库（与现有素材重名时需 body `{resolution: "new"\|"merge"\|"skip"}`，否则 409；自动带出处溯源并同步向量） |
| POST | `/api/extractions/:id/reject` | 拒绝条目 |

## 爽点雷达

实现：`api/radar.ts` · 前端页面：MetricsPage

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books/:id/radar` | 按章爽点标注 + 章末钩子评级 + 连续压抑预警 |
| POST | `/api/books/:id/chapters/:idx/radar` | 手动重灌单章评测（仅已落稿章；失败不阻塞，返回 200） |

雷达只做观测与预警，不进重写闸门。

## 正文块向量与呼应检索

实现：`api/chapterblocks.ts` · 前端页面：MetricsPage（自相似报告）、WritingPage（呼应检索；`reindex` 目前无页面入口，章节编辑后自动重灌）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/books/:id/chapter-blocks/reindex` | 书级重建正文块向量索引（embed 路由未配置 → 409） |
| GET | `/api/books/:id/similarity` | 跨章自相似报告（纯向量扫描，排除相邻章窗口） |
| POST | `/api/books/:id/chapter-blocks/search` | 呼应检索：查询句 → 全书相似旧段 top-K（body `{query}`，默认 10 条，上限 50） |
