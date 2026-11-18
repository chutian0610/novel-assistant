<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api, errorMessage } from '../api';
import { MATERIAL_FIELDS } from '../materialSchema';
import { MATERIAL_TYPE_LABELS, type BookMaterialItem } from '../types';

const props = defineProps<{ bookId: number; item: BookMaterialItem }>();
const emit = defineEmits<{ saved: []; cancel: [] }>();

const material = props.item.material;

// 表单预填书内生效值；保存时与全局素材求差，差异字段即覆写补丁
const form = reactive({
  title: props.item.effective.title,
  content: props.item.effective.content,
  payload: { ...props.item.effective.payload } as Record<string, string>,
});

const saving = ref(false);
const error = ref<string | null>(null);

const fieldDefs = MATERIAL_FIELDS[material.type];

const overridden = computed(() => new Set(props.item.overriddenFields));

function isOverridden(path: string): boolean {
  return overridden.value.has(path);
}

/** 表单值相对全局素材的偏差即覆写；与全局一致则不覆写（回退全局值）。空差异 = 清除全部覆写 */
function diffOverrides(): { title?: string; content?: string; payload?: Record<string, string> } {
  const patch: { title?: string; content?: string; payload?: Record<string, string> } = {};
  if (form.title !== material.title) patch.title = form.title;
  if (form.content !== material.content) patch.content = form.content;
  const payloadPatch: Record<string, string> = {};
  for (const def of fieldDefs) {
    const formValue = form.payload[def.key] ?? '';
    const globalValue = material.payload[def.key] ?? '';
    if (formValue !== globalValue) payloadPatch[def.key] = formValue;
  }
  if (Object.keys(payloadPatch).length > 0) patch.payload = payloadPatch;
  return patch;
}

async function submit() {
  if (form.title.trim() === '') {
    error.value = '标题不能为空白';
    return;
  }
  if (form.content.trim() === '') {
    error.value = '正文不能为空白';
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    await api.patch(`/api/books/${props.bookId}/materials/${material.id}`, { overrides: diffOverrides() });
    emit('saved');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('cancel')">
    <div class="modal-panel">
      <div class="panel-head">
        <h3>书内覆写：{{ MATERIAL_TYPE_LABELS[material.type] }}「{{ material.title }}」</h3>
        <button class="btn btn-ghost" type="button" @click="emit('cancel')">关闭</button>
      </div>

      <p class="muted small">
        只影响本书：与全局素材不一致的字段成为书内覆写，改回与全局一致即恢复跟随全局。全局素材库不会被修改。
      </p>

      <form class="editor-form" @submit.prevent="submit">
        <label class="editor-label">
          标题<span v-if="isOverridden('title')" class="override-mark">已覆写</span>
          <input v-model="form.title" class="input" type="text" />
        </label>

        <label class="editor-label">
          正文<span v-if="isOverridden('content')" class="override-mark">已覆写</span>
          <textarea v-model="form.content" class="input" rows="5"></textarea>
        </label>

        <div class="editor-section">
          <div class="editor-section-title">{{ MATERIAL_TYPE_LABELS[material.type] }}字段</div>
          <label v-for="def in fieldDefs" :key="def.key" class="editor-label">
            {{ def.label }}<span v-if="isOverridden(`payload.${def.key}`)" class="override-mark">已覆写</span>
            <textarea
              v-if="def.multiline"
              v-model="form.payload[def.key]"
              class="input"
              rows="3"
              :placeholder="def.placeholder"
            ></textarea>
            <input v-else v-model="form.payload[def.key]" class="input" type="text" :placeholder="def.placeholder" />
          </label>
        </div>

        <p v-if="error" class="error-text">{{ error }}</p>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? '保存中……' : '保存覆写' }}</button>
          <button class="btn btn-ghost" type="button" @click="emit('cancel')">取消</button>
        </div>
      </form>
    </div>
  </div>
</template>
