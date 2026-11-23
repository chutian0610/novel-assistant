import type { ChatResult } from '../src/llm/types';

/**
 * 管线闭环测试夹具：正文样本全部经 T7 检测器实算校准——
 * PASS_TEXT 八维全过；FAIL_TEXT 仅 3-gram 句内复读不达标（hits 定位两句坏句）；
 * GOOD 替换坏句段后全维达标（FIXED_TEXT = PASS_TEXT 的期望终稿）。
 */

export const PASS_TEXT =
  '夜风掠过城头，吹得火把猎猎作响。他按刀而立，望着城下连绵的敌军营帐。城下的营帐延绵十余里，灯火稀稀落落，望不到尽头。' +
  '「传令下去，今夜三更造饭，五更出兵，误时者斩。」帐帘掀开，一名斥候滚鞍下马，怀里揣着半块染血的令牌。恐惧像潮水一样漫过心头。' +
  '他压下这股寒意，声音依旧平稳，逐条吩咐完防务，才允许自己喘一口气。三日后，捷报传入京师，皇帝在金銮殿上抚掌大笑，当场赐下蟒袍玉带。' +
  '而此刻的他，正蹲在壕沟里啃冷饼，盘算着下一场恶仗的走法，盘算着粮道，盘算着援兵。';

const BAD_A = '他一刀劈开山岳，又一刀劈开山岳，再一刀劈开山岳，刀刀都劈开山岳，气势汹汹。';
const BAD_B = '他一刀劈开山岳，又一刀劈开山岳。';
const TARGET = '他按刀而立，望着城下连绵的敌军营帐。';

/** 坏句原文（FAIL_TEXT 内嵌的第一句），供重写 prompt 断言 */
export const BAD_SENTENCE = BAD_A;

/** 仅 3-gram 复读不达标（阈值 0.02，实际 0.022；句级 hits 两句） */
export const FAIL_TEXT = PASS_TEXT.replace(TARGET, BAD_A + BAD_B);

/** 定向重写脚本回包：替换坏句段后的达标句 */
export const GOOD_SENTENCE = '他收刀而立，山风卷起染血的衣摆，远处残阳如血，城头的火把次第亮了起来。';

/** fix 循环的期望终稿：坏句段被 GOOD_SENTENCE 替换，其余句逐字保留 */
export const FIXED_TEXT = PASS_TEXT.replace(TARGET, GOOD_SENTENCE);

/** 2 轮重写仍不达标时的脚本回包（与 FAIL_TEXT 同样的坏句段） */
export const STILL_BAD_REWRITE = BAD_A + BAD_B;

/** 语义冲突引文（PASS_TEXT 中的原句）与其重写替换句（替换后仍全维达标） */
export const SEM_QUOTE_OLD = '皇帝在金銮殿上抚掌大笑，当场赐下蟒袍玉带。';
export const SEM_QUOTE_NEW = '皇帝在偏殿听完战报，把捷报按进案头，脸色比殿外的夜色还沉。';

/** 把正文草稿包装成 FakeLLM 的脚本化响应 */
export function draftResult(content: string): ChatResult {
  return { content, model: 'fake-draft' };
}

/** 把语义核查结果包装成 FakeLLM 的脚本化响应 */
export function semanticResult(conflicts: unknown): ChatResult {
  return { content: JSON.stringify({ conflicts }), model: 'fake-verify' };
}
