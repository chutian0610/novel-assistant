<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { api, errorMessage } from '../api';
import { MATERIAL_FIELDS } from '../materialSchema';
import { MATERIAL_TYPE_LABELS, type Material, type MaterialType } from '../types';

const props = defineProps<{ material: Material | null }>();
const emit = defineEmits<{ saved: []; cancel: [] }>();

const isEdit = computed(() => props.material !== null);

const form = reactive({
  type: (props.material?.type ?? 'setting') as MaterialType,
  title: props.material?.title ?? '',
  content: props.material?.content ?? '',
  payload: { ...(props.material?.payload ?? {}) } as Record<string, string>,
  tags: [...(props.material?.tags ?? [])] as string[],
  tagInput: '',
  sourceKind: (props.material?.source.kind ?? 'manual') as 'manual' | 'reference',
  book: props.material?.source.book ?? '',
  chapter: props.material?.source.chapter ?? '',
});

const saving = ref(false);
const error = ref<string | null>(null);

const fieldDefs = computed(() => MATERIAL_FIELDS[form.type]);

// 创建态切换类型时清空结构化字段（各类型 schema 不同）
watch(
  () => form.type,
  (next, prev) => {
    if (!isEdit.value && next !== prev) form.payload = {};
  }
);

function addTag() {
  const name = form.tagInput.trim();
  if (name === '') return;
  if (!form.tags.includes(name)) form.tags.push(name);
  form.tagInput = '';
}

function removeTag(name: string) {
  form.tags = form.tags.filter((tag) => tag !== name);
}

async function submit() {
  const missing = fieldDefs.value.find((def) => def.required && (form.payload[def.key] ?? '').trim() === '');
  if (missing) {
    error.value = `请填写${missing.label}`;
    return;
  }
  if (form.sourceKind === 'reference' && form.book.trim() === '') {
    error.value = '来源为参考书时必须填写来源书名';
    return;
  }
  saving.value = true;
  error.value = null;
  const body = {
    title: form.title,
    content: form.content,
    payload: form.payload,
    tags: form.tags,
    source: {
      kind: form.sourceKind,
      book: form.sourceKind === 'reference' ? form.book.trim() : '',
      chapter: form.sourceKind === 'reference' ? form.chapter.trim() : '',
    },
  };
  try {
    if (isEdit.value && props.material) {
      await api.patch(`/api/materials/${props.material.id}`, body);
    } else {
      await api.post('/api/materials', { ...body, type: form.type });
    }
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
        <h3>{{ isEdit ? '编辑素材' : '新增素材' }}</h3>
        <button class="btn btn-ghost" type="button" @click="emit('cancel')">关闭</button>
      </div>

      <form class="editor-form" @submit.prevent="submit">
        <div class="form-grid">
          <label>类型
            <select v-model="form.type" class="select" :disabled="isEdit">
              <option v-for="(label, type) in MATERIAL_TYPE_LABELS" :key="type" :value="type">{{ label }}</option>
            </select>
          </label>
          <label>标题<input v-model="form.title" class="input" type="text" placeholder="素材标题" /></label>
        </div>

        <label class="editor-label">正文
          <textarea v-model="form.content" class="input" rows="5" placeholder="设定描述 / 桥段写法 / 样文 / 骨骼说明"></textarea>
        </label>

        <div class="editor-section">
          <div class="editor-section-title">{{ MATERIAL_TYPE_LABELS[form.type] }}字段</div>
          <label v-for="def in fieldDefs" :key="def.key" class="editor-label">
            {{ def.label }}<span v-if="def.required" class="required-mark">*</span>
            <textarea v-if="def.multiline" v-model="form.payload[def.key]" class="input" rows="3" :placeholder="def.placeholder"></textarea>
            <input v-else v-model="form.payload[def.key]" class="input" type="text" :placeholder="def.placeholder" />
          </label>
        </div>

        <div class="editor-label">
          标签
          <div class="chip-row">
            <span v-for="tag in form.tags" :key="tag" class="chip">
              {{ tag }}
              <button class="chip-remove" type="button" :aria-label="`移除标签 ${tag}`" @click="removeTag(tag)">×</button>
            </span>
            <input
              v-model="form.tagInput"
              class="input chip-input"
              type="text"
              placeholder="输入标签后回车添加"
              @keydown.enter.prevent="addTag"
            />
          </div>
        </div>

        <div class="editor-label">
          出处溯源
          <div class="source-row">
            <label class="checkbox-label"><input v-model="form.sourceKind" type="radio" value="manual" /> 人工录入</label>
            <label class="checkbox-label"><input v-model="form.sourceKind" type="radio" value="reference" /> 来自参考书</label>
          </div>
          <div v-if="form.sourceKind === 'reference'" class="form-grid">
            <label>来源书名<input v-model="form.book" class="input" type="text" placeholder="书名" /></label>
            <label>来源章节<input v-model="form.chapter" class="input" type="text" placeholder="如：第3章" /></label>
          </div>
          <div v-else class="muted small">人工录入的素材不带出处，后续拆书提取的素材会自动记录来源。</div>
        </div>

        <p v-if="error" class="error-text">{{ error }}</p>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? '保存中……' : '保存' }}</button>
          <button class="btn btn-ghost" type="button" @click="emit('cancel')">取消</button>
        </div>
      </form>
    </div>
  </div>
</template>
