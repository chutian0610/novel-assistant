// 任务类型：与 server/src/llm/types.ts 为镜像副本（前端无构建期共享包），增删任务须两处同步
export const TASK_TYPES = ['outline', 'draft', 'extract', 'verify'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_LABELS: Record<TaskType, string> = {
  outline: '大纲',
  draft: '正文',
  extract: '抽取',
  verify: '核查',
};

export interface Provider {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRoute {
  task: TaskType;
  providerId: number | null;
  providerName: string | null;
  model: string;
  enabled: boolean;
  effectiveModel: string | null;
  updatedAt: string;
}

export interface RouteTestResult {
  ok: boolean;
  latencyMs: number;
  provider: { id: number; name: string } | null;
  model: string | null;
  baseUrl: string | null;
  error?: string;
}

// 素材四类：与 server/src/materials/store.ts 为镜像副本，增删类型须两处同步
export type MaterialType = 'setting' | 'trope' | 'style' | 'skeleton';

export const MATERIAL_TYPE_LABELS: Record<MaterialType, string> = {
  setting: '设定卡',
  trope: '桥段',
  style: '文风样本',
  skeleton: '书骨骼',
};

export interface MaterialSource {
  kind: 'manual' | 'reference';
  book: string;
  chapter: string;
}

export interface Material {
  id: number;
  type: MaterialType;
  title: string;
  content: string;
  payload: Record<string, string>;
  tags: string[];
  source: MaterialSource;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialListResponse {
  items: Material[];
  total: number;
}

export interface TagCount {
  name: string;
  count: number;
}

// ---- 书架（与 server/src/books/store.ts 为镜像副本，增删字段须两处同步） ----

export interface Book {
  id: number;
  title: string;
  /** 书契约元数据：题材/基调/承诺 */
  genre: string;
  tone: string;
  promise: string;
  materialCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookListResponse {
  items: Book[];
  total: number;
}

/** 书内素材条目：全局素材实时引用 + 覆写补丁合并出的生效视图 */
export interface BookMaterialItem {
  materialId: number;
  addedAt: string;
  updatedAt: string;
  material: Material;
  effective: { title: string; content: string; payload: Record<string, string> };
  /** 被覆写的字段点路径（已排序），如 ['content', 'payload.category'] */
  overriddenFields: string[];
}

export interface BookMaterialListResponse {
  items: BookMaterialItem[];
  total: number;
}

// ---- 两级大纲（与 server/src/outlines/store.ts 为镜像副本，增删字段须两处同步） ----

// 章纲状态机：草稿→已批准→锁定；锁定后仅可显式解锁回「已批准」
export type OutlineStatus = 'draft' | 'approved' | 'locked';

export const OUTLINE_STATUS_LABELS: Record<OutlineStatus, string> = {
  draft: '草稿',
  approved: '已批准',
  locked: '锁定',
};

export interface Volume {
  id: number;
  bookId: number;
  title: string;
  /** 卷纲内容：本卷叙事弧线概述 */
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterOutline {
  id: number;
  volumeId: number;
  title: string;
  /** 章纲内容：本章剧情展开概要 */
  summary: string;
  status: OutlineStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OutlineTree {
  volumes: (Volume & { chapters: ChapterOutline[] })[];
}

/** AI 展开方案：作者选定其中一个后写入章纲（index 从 1 起） */
export interface ExpansionOption {
  index: number;
  title: string;
  summary: string;
}

export interface ExpansionResult {
  options: ExpansionOption[];
  model: string;
}

// ---- 事实四表（与 server/src/facts/store.ts 为镜像副本，增删字段须两处同步） ----

export type CharacterStateCategory = 'injury' | 'secret' | 'possession' | 'realm' | 'other';

export const CHARACTER_STATE_CATEGORY_LABELS: Record<CharacterStateCategory, string> = {
  injury: '伤势',
  secret: '秘密',
  possession: '持有物',
  realm: '境界',
  other: '其他',
};

// 事实来源：落稿回灌（auto）或人工维护（manual）
export type FactOrigin = 'auto' | 'manual';

/** 角色运行时：人物在某章的动态状态，带来源章与原文证据 */
export interface CharacterState {
  id: number;
  bookId: number;
  name: string;
  chapter: number;
  category: CharacterStateCategory;
  content: string;
  evidence: string;
  origin: FactOrigin;
  createdAt: string;
  updatedAt: string;
}

/** 人物关系：有向边 from → to */
export interface CharacterRelation {
  id: number;
  bookId: number;
  fromName: string;
  toName: string;
  relation: string;
  chapter: number;
  evidence: string;
  origin: FactOrigin;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEvent {
  id: number;
  bookId: number;
  chapter: number;
  title: string;
  content: string;
  evidence: string;
  origin: FactOrigin;
  createdAt: string;
  updatedAt: string;
}

export type ForeshadowStatus = 'planted' | 'progressing' | 'resolved' | 'abandoned';

export const FORESHADOW_STATUS_LABELS: Record<ForeshadowStatus, string> = {
  planted: '已埋设',
  progressing: '推进中',
  resolved: '已回收',
  abandoned: '已放弃',
};

export interface Foreshadow {
  id: number;
  bookId: number;
  title: string;
  content: string;
  status: ForeshadowStatus;
  /** 埋设章 */
  plantedChapter: number;
  /** 目标章：当前章超过此章仍未回收即预警 */
  targetChapter: number;
  evidence: string;
  origin: FactOrigin;
  createdAt: string;
  updatedAt: string;
}

/** 伏笔视图 = 账本记录 + 预警标志 */
export interface ForeshadowView extends Foreshadow {
  overdue: boolean;
}

export interface FactListResponse<T> {
  items: T[];
  total: number;
}

// ---- 拆书提取（与 server/src/references/store.ts 为镜像副本，增删字段须两处同步） ----

export type ReferenceFormat = 'txt' | 'epub';

export interface ReferenceChapter {
  id: number;
  idx: number;
  title: string;
  content: string;
  charCount: number;
  extractStatus: 'pending' | 'done';
}

export interface ReferenceBook {
  id: number;
  title: string;
  format: ReferenceFormat;
  chapterCount: number;
  extractedCount: number;
  pendingItemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceDetail extends ReferenceBook {
  chapters: ReferenceChapter[];
}

export interface ReferenceListResponse {
  items: ReferenceBook[];
  total: number;
}

export interface ExtractionConflict {
  materialId: number;
  title: string;
}

export interface ExtractionItem {
  id: number;
  referenceId: number;
  /** 所属章节；null 表示全书级条目（全书骨骼提取 / 骨骼仿写产出），chapterTitle 为「全书」 */
  chapterId: number | null;
  chapterTitle: string;
  /** 仿写条目的源书骨骼素材 */
  sourceSkeleton: { materialId: number; title: string } | null;
  type: MaterialType;
  title: string;
  content: string;
  payload: Record<string, string>;
  status: 'pending' | 'accepted' | 'rejected';
  resolution: 'new' | 'merge' | 'skip' | null;
  materialId: number | null;
  conflict: ExtractionConflict | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionListResponse {
  items: ExtractionItem[];
  total: number;
}

export interface ExtractRunResult {
  processed: { chapterId: number; chapterTitle: string; itemCount: number }[];
  failed: { chapterId: number; chapterTitle: string; error: string }[];
  remaining: number;
}

// ---- 注入视图（与 server/src/packing/pack.ts 为镜像副本，增删字段须两处同步） ----

export type PackingLayerKey = 'contract' | 'outline' | 'characters' | 'relevance';

export interface PackingItem {
  refType: 'book-contract' | 'volume-outline' | 'chapter-outline' | 'character-state' | 'material';
  refId: number | null;
  title: string;
  /** 注入文本（与后续 prompt 装填共用） */
  text: string;
  tokens: number;
  /** 出处章节号；null 表示该条目无章节维度 */
  sourceChapter: number | null;
  /** 相关度名次（1 = 最相关）；仅相关性层条目携带 */
  rank?: number;
}

export interface PackingLayer {
  key: PackingLayerKey;
  label: string;
  kind: 'must' | 'relevance';
  items: PackingItem[];
  tokens: number;
  /** 相关性层是否因预算截断 */
  truncated: boolean;
  /** 因预算放下的候选条数 */
  droppedCount: number;
}

export interface InjectionView {
  bookId: number;
  chapter: number;
  budgetTokens: number;
  usedTokens: number;
  /** 必带层不可截断，预算小于必带层时超额为 true */
  overBudget: boolean;
  layers: PackingLayer[];
}

// ---- 检测器（与 server/src/detectors/metrics.ts 为镜像副本，增删字段须两处同步） ----

export const METRIC_KEYS = [
  'trigramRepetition',
  'sentenceLengthCV',
  'lexicalDiversity',
  'templatePhrase',
  'punctuationCV',
  'dialogueRatio',
  'emotionDensity',
  'semanticSmoothness',
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_KEY_LABELS: Record<MetricKey, string> = {
  trigramRepetition: '句内 3-gram 复读率',
  sentenceLengthCV: '句长波动',
  lexicalDiversity: '词汇多样性',
  templatePhrase: '模板套话',
  punctuationCV: '标点节奏',
  dialogueRatio: '对白比例',
  emotionDensity: '情绪密度',
  semanticSmoothness: '语义平滑',
};

/** 加权权重（与 server 同源固化；权重序：重复>句长>词汇>模板>标点>对白>情绪>语义） */
export const METRIC_WEIGHTS: Record<MetricKey, number> = {
  trigramRepetition: 0.25,
  sentenceLengthCV: 0.2,
  lexicalDiversity: 0.15,
  templatePhrase: 0.12,
  punctuationCV: 0.1,
  dialogueRatio: 0.08,
  emotionDensity: 0.06,
  semanticSmoothness: 0.04,
};

export interface DetectorConfig {
  lexicalDiversityThreshold: number;
  sentenceLengthCVThreshold: number;
  trigramRepetitionThreshold: number;
  templatePhrasePerKiloWordThreshold: number;
  punctuationCVMin: number;
  punctuationCVMax: number;
  dialogueRatioMin: number;
  dialogueRatioMax: number;
  emotionDensityMin: number;
  emotionDensityMax: number;
  semanticSmoothnessCVThreshold: number;
}

export interface MetricResult {
  key: MetricKey;
  /** 原始指标值 */
  value: number;
  threshold: number | { min: number; max: number };
  pass: boolean;
  /** 归一化问题分 0~1 */
  score: number;
  /** 问题/证据句索引（仅句级证据维度） */
  hits: number[];
  /** 样本不足无法计算，不计入评分 */
  skipped?: boolean;
}

export interface DetectionReport {
  sentences: string[];
  metrics: MetricResult[];
  /** 加权 AI 倾向分 0~100（未降权） */
  aiScore: number;
  /** 短文本降权系数 0~1 */
  confidence: number;
  /** aiScore × confidence */
  adjustedScore: number;
  wordCount: number;
  insufficient: boolean;
}

// ---- 章节管线与写作台（与 server/src/pipeline/store.ts 为镜像副本，增删字段须两处同步） ----

// 管线阶段：stage 记录「下一个待执行阶段」，done 表示全部完成
export type PipelineStage = 'prepare' | 'draft' | 'verify' | 'fix' | 'commit' | 'done';

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  prepare: '准备',
  draft: '草稿',
  verify: '核查',
  fix: '修订',
  commit: '落盘',
  done: '完成',
};

// 管线状态：suspended = 闸门未过，挂起等待人工裁决
export type PipelineStatus = 'running' | 'done' | 'failed' | 'suspended';

export const PIPELINE_STATUS_LABELS: Record<PipelineStatus, string> = {
  running: '进行中',
  done: '已完成',
  failed: '失败',
  suspended: '已挂起',
};

/** LLM 语义核查报告（verify 任务路由产出，对照事实库） */
export interface SemanticConflict {
  /** 正文中矛盾的原句 */
  quote: string;
  explanation: string;
  /** 冲突的事实摘要（可为空串） */
  factHint: string;
}

export interface SemanticReport {
  conflicts: SemanticConflict[];
}

export interface PipelineRun {
  bookId: number;
  /** 章号（1 起，大纲树顺序） */
  idx: number;
  stage: PipelineStage;
  status: PipelineStatus;
  /** 已执行的阶段步数（含失败尝试；断点续跑累计） */
  attempts: number;
  error: string | null;
  /** prepare 产物：本次生成实际装填的注入视图 */
  preparedView: InjectionView | null;
  /** draft/fix 产物：当前正文草稿 */
  draftContent: string | null;
  /** 已执行的定向重写轮数 */
  fixRounds: number;
  /** verify 产物：8 维检测报告（双报告之一） */
  detectionReport: DetectionReport | null;
  /** verify 产物：LLM 语义核查报告（双报告之二） */
  semanticReport: SemanticReport | null;
  /** 落稿后事实回灌的失败信息（null = 已回灌或无需回灌）；失败不阻塞提交，可手动重灌 */
  extractError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Chapter {
  bookId: number;
  idx: number;
  /** 生成时章纲标题的快照 */
  title: string;
  outlineId: number | null;
  content: string;
  /** 滚动摘要（content 的派生物，随正文写入同步重算） */
  summary: string;
  charCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 快照来源：管线 commit / 人工编辑 / 快照回退 */
export type SnapshotSource = 'pipeline' | 'edit' | 'revert';

export const SNAPSHOT_SOURCE_LABELS: Record<SnapshotSource, string> = {
  pipeline: '管线生成',
  edit: '人工编辑',
  revert: '快照回退',
};

export interface ChapterSnapshot {
  id: number;
  content: string;
  summary: string;
  source: SnapshotSource;
  createdAt: string;
}

export interface ChapterDetail {
  chapter: Chapter;
  run: PipelineRun | null;
  snapshots: ChapterSnapshot[];
}

export interface ChapterListItem {
  idx: number;
  title: string;
  outlineId: number | null;
  summary: string;
  charCount: number;
  createdAt: string;
  updatedAt: string;
  run: Pick<PipelineRun, 'stage' | 'status' | 'attempts' | 'error'> | null;
}

export interface ChapterListResponse {
  items: ChapterListItem[];
  total: number;
}

export interface GenerateResult {
  /** commit 完成返回章节；挂起（闸门未过）返回 null */
  chapter: Chapter | null;
  run: PipelineRun;
  snapshots: ChapterSnapshot[];
}

// ---- 挂起队列（与 server/src/pipeline/store.ts 为镜像副本，增删字段须两处同步） ----

export type SuspensionSource = 'detection' | 'semantic';

export const SUSPENSION_SOURCE_LABELS: Record<SuspensionSource, string> = {
  detection: '检测未达标',
  semantic: '事实矛盾',
};

export type SuspensionResolution = 'rewrite' | 'ignore' | 'fact' | 'auto';

export const SUSPENSION_RESOLUTION_LABELS: Record<SuspensionResolution, string> = {
  rewrite: '定向重写',
  ignore: '忽略放行',
  fact: '修正事实',
  auto: '冲突消除',
};

export interface SuspensionDetail {
  metricKey?: string;
  hits?: number[];
  sentences?: string[];
  /** 全文级维度聚合项：无法定位段落的维度键列表 */
  metricKeys?: string[];
  fullText?: boolean;
  quote?: string;
  explanation?: string;
  factHint?: string;
}

export interface Suspension {
  id: number;
  bookId: number;
  idx: number;
  source: SuspensionSource;
  title: string;
  reason: string;
  detail: SuspensionDetail;
  /** 创建时的 fix 轮次：闸门只看当前轮的检测项 */
  round: number;
  status: 'pending' | 'resolved';
  resolution: SuspensionResolution | null;
  createdAt: string;
  updatedAt: string;
}

export interface SuspensionListResponse {
  items: Suspension[];
  total: number;
}

/** 挂起队列动作响应：运行状态 + 可能已 commit 的章节 + 剩余 pending 项 */
export interface SuspensionActionResult {
  run: PipelineRun | null;
  chapter: Chapter | null;
  suspensions: Suspension[];
}

// ---- 检测指标趋势（与 server/src/pipeline/store.ts 为镜像副本，增删字段须两处同步） ----

export interface ChapterMetrics {
  idx: number;
  title: string | null;
  aiScore: number;
  confidence: number;
  adjustedScore: number;
  wordCount: number;
  metrics: MetricResult[];
  updatedAt: string;
}

export interface ChapterMetricsResponse {
  items: ChapterMetrics[];
  total: number;
}
