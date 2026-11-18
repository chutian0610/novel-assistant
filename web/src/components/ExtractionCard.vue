<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api, errorMessage } from '../api';
import { MATERIAL_FIELDS } from '../materialSchema';
import { MATERIAL_TYPE_LABELS, type ExtractionItem } from '../types';

const props = defineProps<{ item: ExtractionItem }>();
const emit = defineEmits<{ changed: []; removed: []; adapt: [] }>();

const form = reactive({
  title: props.item.title,
  content: props.item.content,
  payload: { ...props.item.payload } as Record<string, string>,
});

const busy = ref(false);
const error = ref<string | null>(null);

const fieldDefs = MATERIAL_FIELDS[props.item.type];
const isArchived = computed(() => props.item.status !== 'pending');
/** 已入库的书骨骼可一键仿写（仿写来源条目本身除外） */
const canAdapt = computed(
  () => isArchived.value && props.item.status === 'accepted' && props.item.type === 'skeleton' && props.item.materialId !== null && props.item.sourceSkeleton === null
);

function diffPatch(): { title?: string; content?: string; payload?: Record<string, string> } {
  const patch: { title?: string; content?: string; payload?: Record<string, string> } = {};
  if (form.title !== props.item.title) patch.title = form.title;
  if (form.content !== props.item.content) patch.content = form.content;
  const payloadPatch: Record<string, string> = {};
  for (const def of fieldDefs) {
    if ((form.payload[def.key] ?? '') !== (props.item.payload[def.key] ?? '')) payloadPatch[def.key] = form.payload[def.key] ?? '';
  }
  if (Object.keys(payloadPatch).length > 0) patch.payload = payloadPatch;
  return patch;
}

async function saveEdits() {
  const patch = diffPatch();
  if (Object.keys(patch).length === 0) return true;
  busy.value = true;
  error.value = null;
  try {
    await api.patch(`/api/extractions/${props.item.id}`, patch);
    emit('changed');
    return true;
  } catch (cause) {
    error.value = errorMessage(cause);
    return false;
  } finally {
    busy.value = false;
  }
}

async function accept(resolution?: 'new' | 'merge' | 'skip') {
  busy.value = true;
  error.value = null;
  const body: Record<string, unknown> = {};
  const patch = diffPatch();
  if (Object.keys(patch).length > 0) body.patch = patch;
  if (resolution !== undefined) body.resolution = resolution;
  try {
    await api.post<ExtractionItem>(`/api/extractions/${props.item.id}/accept`, body);
    emit('changed');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}

async function reject() {
  if (!window.confirm('拒绝这条抽取结果？')) return;
  busy.value = true;
  error.value = null;
  try {
    await api.post(`/api/extractions/${props.item.id}/reject`, {});
    emit('removed');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <article class="material-card" :class="{ 'archived-card': isArchived }">
    <div class="material-head">
      <span class="badge badge-type">{{ MATERIAL_TYPE_LABELS[item.type] }}</span>
      <span class="muted small">{{ item.chapterTitle }}</span>
      <span v-if="item.sourceSkeleton" class="chip chip-static accent-chip">仿写自《{{ item.sourceSkeleton.title }}》</span>
      <div class="material-actions" v-if="!isArchived">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="saveEdits">保存修改</button>
        <button class="btn btn-danger-ghost" type="button" :disabled="busy" @click="reject">拒绝</button>
      </div>
    </div>

    <div v-if="item.conflict && !isArchived" class="conflict-banner">
      与素材库已有素材重名：<strong>「{{ item.conflict.title }}」</strong>
      <span class="muted small">（#{{ item.conflict.materialId }}）</span>
    </div>
    <p v-if="isArchived" class="muted small">
      已处理：{{ item.resolution === 'skip' ? '跳过未入库' : `已入库（素材 #${item.materialId}）` }}
    </p>

    <template v-if="!isArchived">
      <label class="editor-label">标题
        <input v-model="form.title" class="input" type="text" />
      </label>
      <label class="editor-label">正文
        <textarea v-model="form.content" class="input" rows="3"></textarea>
      </label>
      <label v-for="def in fieldDefs" :key="def.key" class="editor-label">
        {{ def.label }}
        <textarea
          v-if="def.multiline"
          v-model="form.payload[def.key]"
          class="input"
          rows="2"
          :placeholder="def.placeholder"
        ></textarea>
        <input v-else v-model="form.payload[def.key]" class="input" type="text" :placeholder="def.placeholder" />
      </label>
    </template>

    <p v-if="error" class="error-text">{{ error }}</p>
    <div v-if="!isArchived" class="accept-row">
      <button class="btn btn-primary" type="button" :disabled="busy" @click="accept()">确认入库</button>
      <template v-if="item.conflict">
        <span class="muted small">重名处理：</span>
        <button class="btn" type="button" :disabled="busy" @click="accept('new')">仍新建</button>
        <button class="btn" type="button" :disabled="busy" @click="accept('merge')">合并入已有</button>
        <button class="btn" type="button" :disabled="busy" @click="accept('skip')">跳过不入库</button>
      </template>
    </div>
    <div v-if="canAdapt" class="accept-row">
      <button class="btn btn-primary" type="button" @click="emit('adapt')">一键仿写：生成全新设定与角色</button>
      <span class="muted small">基于该骨骼的结构方法论产出原创设定卡，走确认队列入库。</span>
    </div>
  </article>
</template>
