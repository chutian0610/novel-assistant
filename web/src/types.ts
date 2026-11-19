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

/** 角色运行时：人物在某章的动态状态，带来源章与原文证据 */
export interface CharacterState {
  id: number;
  bookId: number;
  name: string;
  chapter: number;
  category: CharacterStateCategory;
  content: string;
  evidence: string;
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

export type MetricKey =
  | 'trigramRepetition'
  | 'sentenceLengthCV'
  | 'lexicalDiversity'
  | 'templatePhrase'
  | 'punctuationCV'
  | 'dialogueRatio'
  | 'emotionDensity'
  | 'semanticSmoothness';

export const METRIC_KEY_LABELS: Record<MetricKey, string> = {
  trigramRepetition: '3-gram 重复',
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
