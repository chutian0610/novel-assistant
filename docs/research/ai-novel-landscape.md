# AI 长篇小说生成工作台 · 技术方案调研

日期:2026-11-17。范围:开源 AI 小说项目、素材提取、长篇一致性、agent 编排选型。核心参考:一篇对 57 个开源写作项目的源码级横评([来源](https://blog.lynxflow.co/posts/open-source-ai-novel-writing-platform-selection-audit-2026))。

## a) 最相关开源项目对比

| 项目 | 核心机制 | 素材/设定管理 | 长篇一致性 | 活跃度/License | 可借鉴点 |
|---|---|---|---|---|---|
| [webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer) | Claude Code 插件:7 个 skill + 4 个子代理(context/reviewer/data/deconstruction),每章走 上下文→起草→审查→润色→提交 五阶段 | Story System:设定/角色/伏笔/题材模板存为 Markdown+CSV+JSON 文件,可 BM25/向量检索 | 章节原子提交同步更新 state/索引/摘要/记忆/向量五份派生文件;三层记忆 working/episodic/semantic | 约 8k star,活跃;**GPL-3.0** | 拆书代理;MemoryItem schema;把"记忆"做成纯文件派生层 |
| [AI_NovelGenerator](https://github.com/YILING0013/AI_NovelGenerator) | PyQt GUI,世界观→蓝图→章节流水线,各阶段可配不同模型 | 设定工坊+知识库导入本地文档 | 三层记忆(近章全文/滚动摘要/Chroma 向量)+consistency_checker 门禁+伏笔台账;作者复盘:纯向量库无时间序,后期致乱,新版改为数据库全量开放供 AI 自主查询/更新,并引入篇章-场景-章节三层结构([作者自述](https://www.locdd.com/t/topic/100987/13)) | 约 6k star,维护中;**AGPL-3.0** | 三层记忆架构;consistency_checker;对向量库局限的一手教训 |
| [show-me-the-story](https://github.com/Nigh/show-me-the-story) | Go 单二进制+Svelte,六步原子管线:大纲→写作→事实核查→伏笔更新→记忆提取 | 角色/世界观/组织/关系独立条目化,分层注入 prompt | 伏笔状态机 planted→progressing→resolved/abandoned+超期告警;核查失败→根因分析→重写;冲突挂起交人工裁决([架构](https://zread.ai/Nigh/show-me-the-story)) | 数百 star;**MIT** | 最值得 fork 的底座:断点续跑、伏笔状态机、闭环核查全齐 |
| [Long-Novel-GPT](https://github.com/MaoXiaoYuZ/Long-Novel-GPT) | LLM+RAG agent:大纲-章节-正文自上而下扩写+反思循环 | 支持导入已有小说"拆书"(提取剧情与人物关系→生成剧情纲要),风格 prompt(如天蚕土豆风) | 层次化大纲锁定剧情;检索相关片段同步更新纲要 | 万星级但迭代放缓 | 拆书思路与自上而下扩写范式 |
| [AI-Morpheus](https://github.com/taomylife521/AI-Morpheus) | FastAPI+React,多 agent(Director/Setter/Stylist/Arbiter)+SSE 流式 | 三层记忆 L1 Identity/L2 Entities/L3 Events | SQLite FTS5+LanceDB 混合检索,生成前组装 context pack(身份+状态+记忆压缩+前情+开放线程) | 中小项目,持续开发 | L1/L2/L3 记忆分层与混合检索 |
| [gpt-author](https://github.com/mshumer/gpt-author) | prompt→GPT-4 出目录→逐章带前文生成→Claude edit pass→EPUB | 无设定管理 | 仅前章上下文 | 基本停更 | 极简基线;"生成后再过一遍编辑"两段式 |

另:[SillyTavern World Info/Lorebook](https://docs.sillytavern.app/usage/core-concepts/worldinfo/) 是人物卡持久一致性的事实标准;[Mythpen](https://github.com/niyongsheng/mythpen) 是本地优先桌面工作台,角色/世界观/伏笔/时间线统一管理+旧书导入,形态与本项目最接近。

## b) 素材提取方案综述

- **拆书产物四分类**已成共识:情节片段(带标签)、角色、世界元素、故事大纲,如 [AI-Novel-Weaver 一键拆书](http://github.cc/wynnforthework/ai-novel-weaver);Mythpen 旧书导入 TXT/EPUB 自动生成角色/世界观/时间线/伏笔/叙事记忆;webnovel-writer 的 deconstruction-agent 进一步从参考书提炼"可迁移写法"回写项目记忆。
- **人物卡 schema**:无统一标准,可用字段共识=身份+want/fear+关系+当前状态+语言风格。可借鉴 [Avatar](https://desty.github.io/en/projects/avatar/)(从原文抽取 Big Five 人格、语言模式、价值观、关系,2187 条对白建角色)与 [novel-characters skill](https://skills.rest/skill/novel-characters)(小说→结构化 JSON 角色档案)。[Story Bible 指南](https://www.entangledtext.com/guides/story-bible-ai-models-follow)建议全书 bible 控制在 800–1200 词:角色卡 3–5 行+世界规则+"不可矛盾清单",每次生成前注入——证明素材库必须区分"库"(全量)与"注入视图"(压缩)。
- **文风**:主流做法双轨——统计特征(可并入本项目 8 维检测器)+ 样例段落/风格 prompt(Long-Novel-GPT 的风格 prompt 库、webnovel-writer 的题材 CSV)。
- **桥段/关系抽取**:普遍按场景切块后 LLM 结构化输出,无现成标准 schema,需自定义(建议:桥段=场景摘要+功能标签+出场角色+情绪曲线采样点)。

## c) 长篇一致性方案综述

- **分层上下文是收敛答案**:近章全文+每 N 章滚动摘要+长程检索(横评结论);先行摘要、按需上向量最省钱。
- **向量库不是银弹**:AI_NovelGenerator 作者实测"向量库没有时间关系,分不清前后顺序,后期反而造成混乱",改为结构化库+AI 自主查询;Morpheus 用 FTS5+向量混合排序;webnovel-writer 无向量配置时退回 BM25。启示:**时间戳/章节号必须是一等公民,检索结果按叙事位置重排**。
- **伏笔登记表**:show-me-the-story 的状态机(唯一 ID/埋设章/目标章/事件日志/超期告警)同时注入写作 prompt("应推进")与核查 prompt("过早回收或遗忘计为矛盾"),形成反馈闭环。
- **角色/时间线状态库**:webnovel-writer 的 [memory_scratchpad](https://github.com/lingfengQAQ/webnovel-writer/blob/master/docs/memory/long-term-memory-architecture-v2.md) 按 character_state/relationships/world_rules/timeline/open_loops/reader_promises 分桶,MemoryItem 含 source_chapter 与 evidence 字段、状态机 active/outdated/contradicted/tentative、超阈值自动压缩——可直接抄的 schema。
- **注入策略**:SillyTavern Lorebook 的关键词触发+递归扫描+插入顺序+token 预算+Sticky/Cooldown,是"按需注入设定"的成熟工程范本。
- **质量闭环**:show-me-the-story 事实核查失败→根因分析→重写,不可解冲突挂起给人工;webnovel-writer 审查指标落库并出质量趋势报告。LLM 语义核查与确定性统计指标(即本项目的 8 维)并行,是合理分工。

## d) agent 编排与栈选型参考

- **三种形态**:①宿主 agent 插件(webnovel-writer 基于 Claude Code skills/hooks,零自建 UI 成本);②自研顺序流水线(show-me-the-story:六步管线+progress.json 断点续跑;gpt-author 最简两段式);③图编排([SAGA](https://www.reddit.com/r/LocalLLaMA/comments/1poh4qz/saga_migrated_my_localfirst_novelwriting_system/):LangGraph+Neo4j 知识图谱本地化写作;[Medium 教程](https://medium.com/@kishorek/how-to-build-an-ai-powered-novel-writing-workflow-with-langgraph-langchain-2ef915ef39b1))。
- **横评结论**:长篇连载是"长流程、按章计费、必须断点续跑的批处理",阶段流水线优于自主 ReAct agent(写到第 280 章崩溃后不希望 agent 重新规划人生);text 层 OpenAI-compatible 三件套(base_url/key/model)使 provider 真正可插拔。
- LangGraph 价值点在人工审核中断、回溯、条件分支;若流程是确定的"章级状态机+落盘",自研循环+直连 API 更轻,上述多数项目均如此。

## e) 对本项目的 5 条建议

1. **编排采用"章节级状态机流水线"**(prepare→draft→verify→fix→commit),每阶段落盘、可断点续跑;不用自由 ReAct。生成与校正做成独立可重试步骤,commit 时原子更新全部派生物(正文、摘要、状态库、伏笔表、指标库)。
2. **一致性以结构化事实库为主、检索为辅**:SQLite 四张核心表(角色状态/关系/时间线/伏笔),每条事实带 source_chapter+evidence 供审计;检索层 BM25 起步、混合向量按需加;所有检索结果按章节号重排后再注入。
3. **伏笔复刻状态机**:planted/progressing/resolved/abandoned+目标章+超期告警,同时注入生成与核查两个 prompt;角色状态每章 diff 更新而非全量重写。
4. **质量闭环分层**:8 个 AI 痕迹维度做成确定性统计指标器(纯代码,不烧 token),与 LLM 语义核查并行;不达标→定向重写对应段落而非整章;指标按章落库出趋势,反 AI 痕迹调整放在润色阶段。
5. **License 纪律**:show-me-the-story(MIT)可作架构参考甚至 fork;webnovel-writer(GPL)、AI_NovelGenerator(AGPL)只借鉴设计不抄代码;素材 schema 直接融合 webnovel-writer 的 MemoryItem 分桶与 Story Bible 的压缩注入视图。

主要来源:[57 项目横评](https://blog.lynxflow.co/posts/open-source-ai-novel-writing-platform-selection-audit-2026) · [webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer) · [show-me-the-story](https://github.com/Nigh/show-me-the-story) · [AI_NovelGenerator](https://github.com/YILING0013/AI_NovelGenerator) · [Long-Novel-GPT](https://github.com/MaoXiaoYuZ/Long-Novel-GPT) · [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/) · [AI-Morpheus](https://github.com/taomylife521/AI-Morpheus) · [Mythpen](https://github.com/niyongsheng/mythpen)
