<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { CHARACTER_STATE_CATEGORY_LABELS, type CharacterStateCategory } from '../types';

/** 事实四表共用的编辑模态：按 kind 切换字段组；API 调用与错误状态由父组件管理 */
export type FactKind = 'character' | 'relation' | 'timeline' | 'foreshadow';

export interface FactFormValue {
  name?: string;
  fromName?: string;
  toName?: string;
  relation?: string;
  chapter?: number;
  category?: CharacterStateCategory;
  title?: string;
  content?: string;
  evidence?: string;
  plantedChapter?: number;
  targetChapter?: number;
}

const props = defineProps<{
  kind: FactKind;
  heading: string;
  initial: Partial<FactFormValue>;
  saving: boolean;
  error: string | null;
}>();
const emit = defineEmits<{ saved: [value: FactFormValue]; cancel: [] }>();

const form = reactive({
  name: props.initial.name ?? '',
  fromName: props.initial.fromName ?? '',
  toName: props.initial.toName ?? '',
  relation: props.initial.relation ?? '',
  chapter: props.initial.chapter?.toString() ?? '',
  category: (props.initial.category ?? 'other') as CharacterStateCategory,
  title: props.initial.title ?? '',
  content: props.initial.content ?? '',
  evidence: props.initial.evidence ?? '',
  plantedChapter: props.initial.plantedChapter?.toString() ?? '',
  targetChapter: props.initial.targetChapter?.toString() ?? '',
});

const localError = ref<string | null>(null);

const isCharacter = computed(() => props.kind === 'character');
const isRelation = computed(() => props.kind === 'relation');
const isTimeline = computed(() => props.kind === 'timeline');

function toChapter(raw: string, label: string): number | string {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return `${label}应为正整数`;
  return n;
}

function submit() {
  localError.value = null;
  if (isCharacter.value) {
    if (form.name.trim() === '') return fail('请填写角色名');
    if (form.content.trim() === '') return fail('请填写状态内容');
    if (form.evidence.trim() === '') return fail('请填写原文证据');
    const chapter = toChapter(form.chapter, '来源章');
    if (typeof chapter === 'string') return fail(chapter);
    emit('saved', { name: form.name.trim(), chapter, category: form.category, content: form.content.trim(), evidence: form.evidence.trim() });
    return;
  }
  if (isRelation.value) {
    if (form.fromName.trim() === '') return fail('请填写起始角色');
    if (form.toName.trim() === '') return fail('请填写指向角色');
    if (form.relation.trim() === '') return fail('请填写关系');
    if (form.evidence.trim() === '') return fail('请填写原文证据');
    const chapter = toChapter(form.chapter, '来源章');
    if (typeof chapter === 'string') return fail(chapter);
    emit('saved', {
      fromName: form.fromName.trim(),
      toName: form.toName.trim(),
      relation: form.relation.trim(),
      chapter,
      evidence: form.evidence.trim(),
    });
    return;
  }
  if (isTimeline.value) {
    if (form.title.trim() === '') return fail('请填写事件标题');
    if (form.evidence.trim() === '') return fail('请填写原文证据');
    const chapter = toChapter(form.chapter, '章号');
    if (typeof chapter === 'string') return fail(chapter);
    emit('saved', { chapter, title: form.title.trim(), content: form.content.trim(), evidence: form.evidence.trim() });
    return;
  }
  // foreshadow
  if (form.title.trim() === '') return fail('请填写伏笔标题');
  if (form.evidence.trim() === '') return fail('请填写原文证据');
  const plantedChapter = toChapter(form.plantedChapter, '埋设章');
  if (typeof plantedChapter === 'string') return fail(plantedChapter);
  const targetChapter = toChapter(form.targetChapter, '目标章');
  if (typeof targetChapter === 'string') return fail(targetChapter);
  emit('saved', {
    title: form.title.trim(),
    content: form.content.trim(),
    plantedChapter,
    targetChapter,
    evidence: form.evidence.trim(),
  });
}

function fail(message: string) {
  localError.value = message;
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('cancel')">
    <div class="modal-panel">
      <div class="panel-head">
        <h3>{{ heading }}</h3>
        <button class="btn btn-ghost" type="button" @click="emit('cancel')">关闭</button>
      </div>

      <form class="editor-form" @submit.prevent="submit">
        <template v-if="isCharacter">
          <div class="form-grid">
            <label class="editor-label">角色名
              <input v-model="form.name" class="input" type="text" placeholder="如：陆沉舟" />
            </label>
            <label class="editor-label">来源章
              <input v-model="form.chapter" class="input" type="number" min="1" placeholder="该状态在何章成立" />
            </label>
          </div>
          <label class="editor-label">类别
            <select v-model="form.category" class="select">
              <option v-for="(label, value) in CHARACTER_STATE_CATEGORY_LABELS" :key="value" :value="value">{{ label }}</option>
            </select>
          </label>
          <label class="editor-label">状态内容
            <textarea v-model="form.content" class="input" rows="3" placeholder="如：左臂经脉尽断，靠秘药勉强续上"></textarea>
          </label>
        </template>

        <template v-else-if="isRelation">
          <div class="form-grid">
            <label class="editor-label">起始角色（from）
              <input v-model="form.fromName" class="input" type="text" placeholder="关系的主语" />
            </label>
            <label class="editor-label">指向角色（to）
              <input v-model="form.toName" class="input" type="text" placeholder="关系的宾语" />
            </label>
          </div>
          <div class="form-grid">
            <label class="editor-label">关系
              <input v-model="form.relation" class="input" type="text" placeholder="如：师徒 / 仇敌 / 同门" />
            </label>
            <label class="editor-label">来源章
              <input v-model="form.chapter" class="input" type="number" min="1" placeholder="该关系在何章成立" />
            </label>
          </div>
        </template>

        <template v-else-if="isTimeline">
          <div class="form-grid">
            <label class="editor-label">事件标题
              <input v-model="form.title" class="input" type="text" placeholder="如：测灵大典" />
            </label>
            <label class="editor-label">章号
              <input v-model="form.chapter" class="input" type="number" min="1" placeholder="叙事时序所在章" />
            </label>
          </div>
          <label class="editor-label">事件内容
            <textarea v-model="form.content" class="input" rows="3" placeholder="事件经过（可选）"></textarea>
          </label>
        </template>

        <template v-else>
          <div class="form-grid">
            <label class="editor-label">伏笔标题
              <input v-model="form.title" class="input" type="text" placeholder="如：残玉中的低语" />
            </label>
          </div>
          <div class="form-grid">
            <label class="editor-label">埋设章
              <input v-model="form.plantedChapter" class="input" type="number" min="1" />
            </label>
            <label class="editor-label">目标章（超过未回收预警）
              <input v-model="form.targetChapter" class="input" type="number" min="1" />
            </label>
          </div>
          <label class="editor-label">详情
            <textarea v-model="form.content" class="input" rows="2" placeholder="伏笔详情（可选）"></textarea>
          </label>
        </template>

        <label class="editor-label">原文证据
          <textarea v-model="form.evidence" class="input" rows="2" placeholder="支撑这条事实的原文摘录"></textarea>
        </label>

        <p v-if="localError || error" class="error-text">{{ localError ?? error }}</p>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? '保存中……' : '保存' }}</button>
          <button class="btn btn-ghost" type="button" @click="emit('cancel')">取消</button>
        </div>
      </form>
    </div>
  </div>
</template>
