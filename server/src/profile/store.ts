import type { DB } from '../db/open';
import { getMaterial, type MaterialRecord } from '../materials/store';

/**
 * 作者偏好档案（T14，CONTEXT.md「作者偏好档案」）：文风样本引用 + 主题偏好 + 创作禁区
 * 组成的全局默认配置，对所有书生效——作为常驻内容进入预算装填必带层（authorProfile 层），
 * 并随 draft prompt 注入。
 *
 * 存储：author_profile 单例行（id=1，迁移 v13）。文风样本引用存素材 id 数组（JSON），
 * 读取侧解析并过滤已删除的素材（失效引用自动收敛）；写入侧由 API 层校验 id 存在且为
 * style 类型。账本外无级联：素材删除不影响档案其余字段。
 */

export interface AuthorProfile {
  /** 主题偏好（多行文本） */
  themePreference: string;
  /** 创作禁区（多行文本） */
  taboos: string;
  /** 文风样本素材 id 引用（JSON 落盘） */
  styleSampleIds: number[];
}

export interface AuthorProfileView extends AuthorProfile {
  /** 解析后的文风样本素材（失效引用已过滤） */
  styleSamples: MaterialRecord[];
}

interface ProfileRow {
  theme_preference: string;
  taboos: string;
  style_sample_ids: string;
}

export function getAuthorProfile(db: DB): AuthorProfile {
  const row = db.prepare('SELECT theme_preference, taboos, style_sample_ids FROM author_profile WHERE id = 1').get() as
    | ProfileRow
    | undefined;
  if (!row) return { themePreference: '', taboos: '', styleSampleIds: [] };
  let ids: number[] = [];
  try {
    const parsed: unknown = JSON.parse(row.style_sample_ids);
    if (Array.isArray(parsed)) {
      ids = parsed.filter((id): id is number => Number.isInteger(id) && id > 0);
    }
  } catch {
    ids = [];
  }
  return { themePreference: row.theme_preference, taboos: row.taboos, styleSampleIds: ids };
}

/** 档案视图：引用解析为素材记录，失效引用（素材已删）过滤 */
export function getAuthorProfileView(db: DB): AuthorProfileView {
  const profile = getAuthorProfile(db);
  const styleSamples = profile.styleSampleIds
    .map((id) => getMaterial(db, id))
    .filter((material): material is MaterialRecord => material !== null && material.type === 'style');
  return { ...profile, styleSamples };
}

export interface AuthorProfilePatch {
  themePreference?: string;
  taboos?: string;
  styleSampleIds?: number[];
}

/** 写档案（部分字段；styleSampleIds 的存在性与类型校验在 API 层完成） */
export function updateAuthorProfile(db: DB, patch: AuthorProfilePatch): AuthorProfileView {
  const current = getAuthorProfile(db);
  const next: AuthorProfile = {
    themePreference: patch.themePreference ?? current.themePreference,
    taboos: patch.taboos ?? current.taboos,
    styleSampleIds: patch.styleSampleIds ?? current.styleSampleIds,
  };
  db.prepare('UPDATE author_profile SET theme_preference = ?, taboos = ?, style_sample_ids = ? WHERE id = 1').run(
    next.themePreference,
    next.taboos,
    JSON.stringify(next.styleSampleIds)
  );
  return getAuthorProfileView(db);
}
