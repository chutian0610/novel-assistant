import { getOutlineTree } from '../outlines/store';
import { PackingRangeError } from '../packing/pack';
import type { DB } from '../db/open';
import type { LLMProvider } from '../llm/types';
import { runChapterPipeline, PipelinePreconditionError } from './run';
import type { PipelineConfig } from './config';
import { getChapter, getRun, toCompactRun, type ChapterRecord, type CompactRun } from './store';

/**
 * 全自动连跑（T13，ADR-0001 全自动预设）：一次调用从第一个未完成章连续生成至连跑上限
 * （pipeline_configs.auto_run_limit，默认 5）后自动暂停待审。
 *
 * 停止规则（stopped.reason）：
 * - limit：本次连跑到达上限，暂停待审（作者审阅后再发起即可续跑）；
 * - suspended：任一章闸门未过挂起——后续章一律停止（挂起章节阻塞后续），到挂起队列处理后恢复；
 * - error：阶段失败（LLM 出错/路由未配置等），断点已落盘，修复后连跑自动从断点续跑；
 * - precondition：章纲用尽或未批准；
 * - none：没有待生成的章节（全部已提交）。
 *
 * 复用单章管线（runChapterPipeline）的断点续跑契约：已完成章自动跳过（不重跑不重复计费），
 * 半成品章从落盘断点继续。协作预设（collaborative）不走本入口——逐章审阅语义（API 层 409）。
 */

export type BatchStopReason = 'limit' | 'suspended' | 'error' | 'precondition' | 'none';

export interface BatchChapterOutcome {
  idx: number;
  /** 本章 commit 产物（连跑内每章必然 commit 成功，挂起不会进入 completed） */
  chapter: ChapterRecord;
  /** 运行状态摘要（不带注入视图等重负载） */
  run: CompactRun;
}

export interface BatchStopped {
  reason: BatchStopReason;
  /** 停止时所在章（limit/none 为 null） */
  idx: number | null;
  message: string;
}

export interface BatchResult {
  completed: BatchChapterOutcome[];
  stopped: BatchStopped;
  /** 下一个待生成章号（queue 视图与续跑提示用）；无待生成章时为 null */
  nextIdx: number | null;
}

/** 大纲树顺序上的第一个未完成章（无运行记录或未 done）；全部完成返回 null。
 *  口径说明：取「工作前沿」而非显式起点——跳章生成的（第 5 章已提交、第 4 章未跑）仍从第 4 章起连跑。 */
function nextPendingIdx(db: DB, bookId: number): number | null {
  const tree = getOutlineTree(db, bookId);
  let ordinal = 0;
  for (const volume of tree.volumes) {
    for (const outline of volume.chapters) {
      ordinal += 1;
      const run = getRun(db, bookId, ordinal);
      if (!run || run.status !== 'done') return ordinal;
    }
  }
  return null;
}

/** 全自动连跑：按上限连续生成，遇挂起/失败/前置缺失即停（详见模块注释的停止规则） */
export async function runBatch(
  db: DB,
  llm: LLMProvider,
  bookId: number,
  config: PipelineConfig
): Promise<BatchResult> {
  const startIdx = nextPendingIdx(db, bookId);
  if (startIdx === null) {
    return {
      completed: [],
      stopped: { reason: 'none', idx: null, message: '没有待生成的章节：全部章纲均已提交' },
      nextIdx: null,
    };
  }

  const completed: BatchChapterOutcome[] = [];
  let idx = startIdx;
  for (let round = 0; round < config.autoRunLimit; round++) {
    let result;
    try {
      result = await runChapterPipeline(db, llm, bookId, idx);
    } catch (cause) {
      if (cause instanceof PipelinePreconditionError || cause instanceof PackingRangeError) {
        return {
          completed,
          stopped: { reason: 'precondition', idx, message: `第 ${idx} 章无法启动：${cause instanceof Error ? cause.message : String(cause)}` },
          nextIdx: idx,
        };
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        completed,
        stopped: { reason: 'error', idx, message: `第 ${idx} 章生成失败：${message}` },
        nextIdx: idx,
      };
    }
    if (result.chapter === null) {
      return {
        completed,
        stopped: {
          reason: 'suspended',
          idx,
          message: `第 ${idx} 章闸门未过已挂起（fix 重写轮次用尽或语义核查发现事实矛盾），后续章停止；请到挂起队列处理后再连跑`,
        },
        nextIdx: idx,
      };
    }
    completed.push({ idx, chapter: result.chapter, run: toCompactRun(result.run) });
    idx += 1;
  }

  return {
    completed,
    stopped: {
      reason: 'limit',
      idx: null,
      message: `本次连跑完成 ${completed.length} 章，到达连跑上限（${config.autoRunLimit}），暂停待审；审阅后再连跑即从断点继续`,
    },
    nextIdx: idx,
  };
}

/** 批量队列视图（spec 用户故事：各章所处阶段、断点状态实时可见）：大纲树全位置 ⋈ 运行状态 */
export interface QueueItem {
  idx: number;
  title: string;
  chapter: ChapterRecord | null;
  run: CompactRun | null;
}

export function getPipelineQueue(db: DB, bookId: number): QueueItem[] {
  const tree = getOutlineTree(db, bookId);
  const items: QueueItem[] = [];
  let ordinal = 0;
  for (const volume of tree.volumes) {
    for (const outline of volume.chapters) {
      ordinal += 1;
      const run = getRun(db, bookId, ordinal);
      items.push({
        idx: ordinal,
        title: outline.title,
        chapter: getChapter(db, bookId, ordinal),
        run: run ? toCompactRun(run) : null,
      });
    }
  }
  return items;
}
